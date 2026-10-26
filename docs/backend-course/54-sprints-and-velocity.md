# 54 — Sprints: one active at a time, frozen history and velocity

Phase S4-F5. Code: `apps/api/src/modules/sprints/`,
`computeSprintMetrics()` and `computeVelocity()` in
`packages/shared/src/sprints/sprint.contracts.ts`, `SprintsPage.tsx` and
`SprintDetailPage.tsx`. Builds on chapters 50–53 (work items, backlog,
hierarchy, requirement links).

## 1. A column, not a join table

An item is in at most one sprint at a time, so the assignment is a nullable
`work_items.sprintId`. As with `parentId` and `releaseId`, the foreign key is
composite:

```prisma
sprint Sprint? @relation(fields: [sprintId, projectId], references: [id, projectId])
```

The item's own `projectId` is part of the key, so the database refuses a
sprint of another project or tenant even if a bug in the service let one
through.

## 2. "Only one active sprint" lives in the database too

The service serialises activation per project with an advisory lock
(`sprint-activation:<projectId>`) and then checks for an active sprint. That
is enough for the API, but invariants that matter get a database backstop:

```sql
CREATE UNIQUE INDEX "sprints_one_active_per_project"
  ON "sprints"("projectId") WHERE "status" = 'active';
```

A partial unique index only covers rows matching its `WHERE`, so any number
of planned, completed or cancelled sprints coexist, but two active ones
cannot. Prisma cannot express partial indexes, so it lives only in the
migration; a `P2002` from it is mapped to 409. The test starts four sprints
at once: one 200, three 409, one active row.

## 3. A state machine with frozen terminal states

`SPRINT_TRANSITIONS` is shared by API and web: planned → active → completed,
planned/active → cancelled. Every write first locks the sprint and calls
`assertOpen()` or `assertTransition()` on the **locked** status, never on the
status read before the transaction — otherwise a request that read
"active" could edit a sprint completed a millisecond earlier.

## 4. Carry-over

Closing a sprint moves its unfinished items (`!isClosedWorkItemStatus`) to
`carryOverTo`: the backlog (`sprintId = NULL`) or a planned sprint of the
same project. Done and cancelled items stay, so a completed sprint keeps its
history. The destination is locked together with the sprint, in id order.

## 5. Lock order and deadlocks

Two kinds of transaction touch sprints and items:

- close: sprint `FOR UPDATE` → its items `FOR UPDATE`;
- plan/unplan: every involved sprint `FOR SHARE` → the items `FOR UPDATE`.

Planning first reads the items **without locks** to learn which sprints they
are in, locks those sprints, then locks the items and re-checks that each
item is still in a locked sprint (409 if it moved meanwhile). Because both
paths lock sprints before items, and rows of the same table in id order, a
complete and a concurrent plan cannot wait on each other in a cycle.

## 6. Snapshots versus live metrics

`committedEstimate` is frozen at start and `completedEstimate` at close;
everything else (counts by status, scope, load, progress) is computed on read
by `computeSprintMetrics()`. Velocity is the average completed estimate of
the last `VELOCITY_WINDOW` (3) completed sprints. Snapshots keep velocity
stable when someone later re-estimates an old item.

## 7. Permissions without new names

Reading is `work_items.read`, planning items `work_items.write`, and the
sprint life cycle `work_items.manage`, so the existing role matrix and
project overrides apply unchanged. A hidden project answers 404 on a sprint
and an empty list, exactly like work items.

## Exercises

1. Add `GET /sprints/:id/burndown` from the audit log of the sprint's items.
2. Make velocity configurable per project and test it.
3. Replace the advisory lock by relying only on the partial index and
   explain what error handling changes.
