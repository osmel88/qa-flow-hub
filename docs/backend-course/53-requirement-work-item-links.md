# 53 — Many-to-many links that the database keeps honest

Phase S4-F4. Code: `apps/api/src/modules/requirement-links/`,
`computeImplementation()` in `packages/shared/src/requirements/requirement-links.contracts.ts`,
`RequirementDetailPage.tsx` and the "Implements" section of
`WorkItemDetailPage.tsx`. Builds on chapters 50–52 (work items) and the
traceability chapters.

## 1. A dedicated join table instead of the generic link table

The project already had `traceability_links`, a polymorphic table
(`sourceType`, `sourceId`, …). Polymorphic rows cannot have foreign keys, so
every invariant lives in the service. For requirement ↔ work item we know both
types, so a plain join table is better:

```prisma
model RequirementWorkItemLink {
  requirement Requirement @relation(fields: [requirementId, projectId], references: [id, projectId])
  workItem    WorkItem    @relation(fields: [workItemId, projectId], references: [id, projectId])
  @@unique([requirementId, workItemId, linkType])
}
```

The trick is the **composite foreign key with `projectId`**: one `projectId`
column is shared by both foreign keys, so a row whose requirement and work
item live in different projects (or tenants) simply cannot exist. That needed
one extra unique key, `requirements(id, projectId)`, as the FK target — the
only change to an existing table.

## 2. Idempotent writes

- **Link** uses `createMany({ skipDuplicates: true })`, i.e.
  `INSERT … ON CONFLICT DO NOTHING`. Six identical concurrent requests all get
  200; exactly one reports `created: true` and writes an audit entry. There is
  no read-then-insert window, so no 409 race and no duplicate.
- **Unlink** deletes by the natural key and answers 204 whether or not a row
  was there; only a real deletion is audited. Retrying a request is always
  safe.

## 3. Locks against soft deletes

A link must never point at a deleted end. The transaction first runs
`SELECT … WHERE "deletedAt" IS NULL FOR SHARE` on the requirement, then on the
work item (always in that order, so two transactions cannot deadlock on each
other). A soft delete is an `UPDATE`, which needs a row lock that conflicts
with `FOR SHARE`:

- delete first → the link's `SELECT` waits, re-checks `deletedAt` on the new
  row version and finds nothing → 404;
- link first → the delete waits until the link commits; the link is then
  hidden because every read filters deleted ends.

## 4. Authorization of a relation

A relation changes what _both_ sides report. The rule: the requirement's
project must pass the route check, the caller needs `work_items.write` (the
route) and `requirements.read` (checked in the service), and the work item
must be in the same project. Every failure on a foreign, hidden or deleted id
is the same 404 as for an invented id, so the endpoint cannot be used to probe
other tenants.

## 5. A derived state, computed on read

`computeImplementation(statuses)` is a pure function shared by API and web:

| linked items (excluding cancelled) | state                   |
| ---------------------------------- | ----------------------- |
| none, or none done                 | `not_implemented`       |
| some done                          | `partially_implemented` |
| all done                           | `implemented`           |

Nothing is stored, so it can never go stale when a work item changes status.
The list filter `?implementation=` computes the states of the project once and
turns them into an `id IN (…)` (or `NOT IN` for `not_implemented`, because
most requirements have no link at all).

## 6. Extending the chain

The traceability matrix and the release traceability now include the
implementing work items, so one view answers: which work implements this
requirement, which cases verify it, how they ran, which defects they raised,
and in which release it ships.

## Exercises

1. Why would `findFirst` + `create` produce occasional 409s or 500s under the
   concurrency test, and why does `ON CONFLICT DO NOTHING` not?
2. Swap the lock order in `unlink` only. Construct the interleaving that
   deadlocks with a concurrent `link`.
3. Add a `relates_to` link type: what changes in the unique key, the
   implementation rollup and the filter?
