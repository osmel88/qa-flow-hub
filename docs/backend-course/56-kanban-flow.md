# 56 — Kanban: WIP limits, flow metrics and a trigger for status time

Phase S4-F7. Code: `apps/api/src/modules/kanban/`,
`apps/api/src/modules/work-items/board-cards.ts`,
`packages/shared/src/kanban/kanban.contracts.ts`,
`apps/web/src/pages/KanbanPage.tsx` and the migration
`20270110100000_kanban`. Builds on chapters 51 (ranks) and 55 (Scrum board).

## 1. Same cards, different board

The Scrum board shows one sprint; the Kanban board shows the whole project
and needs no sprint. Both render the same `BoardCard` (epic, feature,
assignee, requirement keys), so building cards, filtering and swimlanes moved
into `board-cards.ts` and both services call it. Kanban columns are simply the
statuses (minus cancelled), so a column _is_ the target status of a move.

## 2. WIP limits under the backlog lock

A WIP limit is a row of `kanban_column_settings (projectId, status, wipLimit)`.
A move into a column runs:

```text
backlog advisory lock (project) → work item FOR UPDATE
  → version check → WIP check (count live items in the target status)
  → anchor check → rank placement → update + audit
```

Because every Kanban move and every WIP limit change take the same project
advisory lock, two cards dropped at once into a column with one free slot are
serialised: the second transaction counts the first card and gets 409.
Reordering inside a full column does not add a card, so it is allowed.

## 3. Why a trigger for `startedAt` and `statusChangedAt`

Status changes come from many paths: the work item form, bulk actions, the
Scrum board, the Kanban board. Setting the timestamps in each service would
be easy to forget, so a `BEFORE INSERT OR UPDATE` trigger sets
`statusChangedAt` whenever `status` changes, sets `startedAt` on the first
move out of backlog/ready and clears it when the item goes back. The
application only reads them.

## 4. Flow metrics as a pure function

`computeFlowMetrics(items, now, windowDays)` lives in the shared package, so
it is unit-tested without a database:

- throughput: items completed in the window, per week;
- cycle time: `completedAt − startedAt`, average, median and 85th percentile
  (nearest rank);
- aging: `now − startedAt` of items in progress, blocked or in review.

The service passes `now` explicitly, which keeps the integration tests
deterministic: they write the timestamps through the owner connection and
assert exact days.

## Exercises

1. Enforce WIP limits on `PATCH /work-items/:id` and bulk status changes.
2. Replace the two timestamps with a `work_item_status_changes` history and
   draw a cumulative flow diagram.
3. Allow custom columns that group several statuses, like the Scrum board.
