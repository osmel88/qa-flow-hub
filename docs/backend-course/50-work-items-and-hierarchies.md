# 50 — Work items: hierarchies without recursion

Phase S4-F1 (ADR 0023). Read the code alongside:
`packages/shared/src/work-items/work-item.contracts.ts`,
`apps/api/src/modules/work-items/` and the migration
`20261213100000_work_items`.

## 1. A wider product, the same rules

From Stage 4 qa-flow-hub covers the delivery lifecycle, not only QA. The new
entity is the **work item**: the unit a team plans and builds. Everything you
learnt about tenancy still applies verbatim: `organizationId` on every row,
`TenantAwareRepository.scope()/active()`, RLS by organization, project
visibility through grants (chapter 44) and "a hidden thing answers like a
missing thing".

## 2. Trees are where integrity goes to die

A parent pointer looks harmless. Then two people act at the same time:

```text
Alice: move feature F under epic E          (valid alone)
Bob:   turn epic E into a story             (valid alone)
Both:  a story containing a feature         (invalid)
```

Each request validated against a snapshot in which the other change had not
happened. Row locks on F and E do not help: Alice locks F, Bob locks E, both
commit. This is the classic _write skew_.

Two ingredients fix it here:

1. **Make cycles impossible instead of detecting them.** Types are ranked
   (`WORK_ITEM_TYPE_RANK`) and a parent must rank strictly higher. Following
   parents always decreases the rank, so you cannot come back to where you
   started, and the depth is bounded by the number of ranks.
2. **Serialise the changes that reshape the tree.** `lockTree()` takes
   `pg_advisory_xact_lock(hashtextextended('work-item-tree:<project>', 0))`.
   It is released automatically at commit or rollback. Plain edits (title,
   status) skip it, so the common path stays parallel.

Lock ordering matters: the tree lock is always taken _before_ any row lock
(`FOR UPDATE` on the item, `FOR SHARE` on a release). If one path took them in
the other order, two transactions could wait for each other forever.

The test `serialises concurrent moves so the tree stays valid` runs exactly
Alice's and Bob's requests in parallel and asserts one wins.

## 3. Let the database say no

`parentId` and `releaseId` are part of composite foreign keys:

```sql
FOREIGN KEY ("parentId", "projectId") REFERENCES "work_items"("id", "projectId")
```

The referenced pair must exist, so a parent from another project is
impossible even for a buggy service or a raw SQL script. The integration test
tries it with the owner connection and expects the database to refuse.

## 4. Optimistic concurrency for humans

Two people edit the same story in two tabs. Pessimistic locks cannot span the
minutes between "open" and "save", so the item carries a `version`. The client
sends the version it read; the service compares it under `FOR UPDATE` and
answers 409 if someone saved first. Every update bumps the version in the same
`UPDATE`. `version` is optional, so scripts that do not care keep working.

## 5. Enumeration, again

Every reference is checked against the item's own project. A parent, release
or item from another project or tenant produces the same status, code and
message as a made-up id; the integration tests compare the error bodies. A
list for a hidden project is an empty page with `total: 0`.

## 6. A TypeScript lesson from this phase

Adding the model made `nest build` fail in 15 repositories with "Excessive
stack depth comparing types". Repositories write `(tx ?? this.prisma)`, a
union of the plain transaction client and the RLS-extended client; checking
that union compares both client types model by model, and one more model
pushed it past the compiler's limit. The fix is in `TenantAwareRepository`:
`prisma` is typed as `PrismaTransaction` (the extension changes no
signatures), and the rare caller that needs `$transaction` uses `rlsClient`.
Note that `tsc -p tsconfig.json` (with tests) passed while the build config
failed: type-checking order changes which comparison blows up, so always run
the real build.

## 7. Exercises

1. Allow a configurable hierarchy per project. Which invariant of section 2
   do you lose, and what would you need instead of the rank?
2. Replace the bounded ancestor walk with a recursive CTE and compare plans.
3. Add `blockedBy` links between items. Can a blocking graph reuse the rank
   trick? Why not?
4. Emit a `work_item.assigned` notification reusing the outbox (chapter 47).
