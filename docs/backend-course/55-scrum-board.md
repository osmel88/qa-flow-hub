# 55 — Scrum board: columns over statuses, ranks and safe moves

Phase S4-F6. Code: `apps/api/src/modules/sprints/sprint-board.service.ts`,
`packages/shared/src/sprints/board.contracts.ts` and
`apps/web/src/pages/BoardPage.tsx`. Builds on chapters 51 (backlog ranks) and
54 (sprints).

## 1. A column is a set of statuses

The board does not store columns. `BOARD_COLUMNS` maps each column to one or
more work item statuses (Backlog/Ready holds `backlog` and `ready`) and a
`target` status. `statusForColumn()` keeps the current status when it
already belongs to the column, so moving a `backlog` item inside the first
column does not turn it into `ready`. Cancelled items have no column and stay
off the board.

## 2. No migration for "order inside a column"

Cards are listed in backlog `rank` order and then split by column, so the
order inside a column is the relative rank of its cards. Placing a card
before or after a neighbour reuses the backlog's gapped ranks
(`WorkItemsService.placeRelative`, which renumbers the project when a gap is
exhausted). The trade-off — the board order and the backlog order are the
same — is recorded as debt 50.

## 3. One move, one transaction, a fixed lock order

```text
backlog advisory lock (project) → sprint FOR SHARE → work item FOR UPDATE
```

- The advisory lock is the same one the backlog uses, so two cards dropped
  at the same position at once get distinct ranks: the second move sees the
  rank the first one wrote.
- The sprint is locked `FOR SHARE`: a move and a complete/cancel (which take
  `FOR UPDATE`) cannot interleave, and only an `active` sprint accepts moves.
- Inside the lock the service re-checks everything the client saw: the item
  is still in this sprint, it is still on the board, its `version` matches
  (optimistic concurrency, 409 otherwise) and the anchor is still in the same
  sprint and column.

Two moves of the same card with the same `version` therefore end as one 200
and one 409, never as a silent overwrite.

## 4. Isolation and permissions

Ids are looked up through tenant-aware repositories under RLS, and the
service compares the project of the sprint, the card and the anchor. Anything
foreign or hidden answers 404 with the same message as a made-up id. Moving
needs `work_items.write`; the route guard checks it on every request, so a
permission revoked while the board is open fails the next move.

## 5. Reading the board

`GET /sprints/board` loads the sprint items once, computes the sprint metrics
on all of them, resolves epics/features from the project hierarchy, the
assignee names and the live requirement keys, then filters and groups in
memory. Filters never change the metrics: progress and velocity describe
the sprint, not the current view.

## Exercises

1. Add a WIP limit per column and reject moves that exceed it (409).
2. Keep a separate per-board order so the backlog order stays untouched.
3. Push board changes to open tabs with server-sent events.
