# 0024 — Backlog order as gapped integer ranks under a project lock

Status: accepted
Date: 2026-12-20
Related: [0023](0023-work-items-ranked-hierarchy.md)

## Context

S4-F2 turns work items into a backlog: one shared, persistent order per
project that people reorder by drag and drop, plus grouped, per-release and
personal views and bulk edits. Reordering is concurrent by nature: several
people drag rows at the same time.

## Options evaluated

| Option                              | Writes per move        | Concurrency                          |
| ----------------------------------- | ---------------------- | ------------------------------------ |
| Dense positions (1, 2, 3…)          | Every row in between   | Long transactions, many locks        |
| Fractional strings (LexoRank)       | One row                | Unbounded key growth, custom compare |
| **Gapped integers (steps of 1024)** | One row, rare renumber | One advisory lock per project        |
| Client sends the full order         | Every row              | Last writer erases the others' moves |

## Decision

1. `work_items.rank INTEGER`, ascending, in steps of `BACKLOG_RANK_STEP`
   (1024). New items go last; the migration ranks existing items by creation.
2. A move is relative: `POST /work-items/:id/move` with exactly one of
   `beforeId` / `afterId`. The new rank is the midpoint between the anchor and
   its neighbour; when no integer is left between them, the project's live
   items are renumbered in one `UPDATE … ROW_NUMBER()` and the slot is
   computed again.
3. Every change to the order (creation and moves) holds the
   `work-item-backlog:<project>` advisory lock, taken after the tree lock and
   before row locks, so concurrent moves apply one after another and ranks
   stay unique.
4. A move is not an edit: it does not bump `version`, so it never makes an
   open edit form stale. It is audited with the old and new rank.
5. `GET /backlog` returns the ordered items (open ones unless
   `includeClosed=true`, at most 500), totals of estimates, and optional
   groups by nearest epic or feature ancestor. `assigneeId=me` is the personal
   backlog; `releaseId` (or `none`) the release backlog.
6. `POST /work-items/bulk` changes status, priority, assignee, release,
   estimate and labels of up to 100 items of one project in one transaction:
   rows are locked in id order (no deadlock between two bulk edits), one
   missing or foreign id refuses the whole batch, and every item gets its own
   audit entry.

## Consequences

- A move writes one row in the common case; renumbering is O(items) but only
  after about ten moves into the same gap.
- Moves in a project are serialised; that is fine at backlog scale and keeps
  the reasoning simple.
- Ranks are project-wide, so a filtered view moves items relative to the
  visible neighbours; hidden items keep their relative place.
