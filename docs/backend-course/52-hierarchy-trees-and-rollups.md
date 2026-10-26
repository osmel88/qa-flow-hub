# 52 — Trees in memory: navigation, rollups and safe reparenting

Phase S4-F3. Code: `WorkItemsService.tree/reparent/rollupOf`,
`computeRollup()` in the shared contracts and
`apps/web/src/pages/HierarchyPage.tsx`. Builds on chapters 50 (ranked
hierarchy) and 51 (backlog order).

## 1. One query, then pure functions

`GET /work-items/tree` loads every live item of the project once (up to 2000,
flagged `truncated` beyond) in backlog order and builds the tree in memory
with a `parentId → children` index. No recursive SQL: the ranked hierarchy
bounds the depth to four, so recursion is shallow and every level keeps the
backlog order for free.

## 2. Rollups are a fold

A node's rollup is computed from the flat list of its descendants by
`computeRollup()`: counts per status, sum of existing estimates, the number of
unestimated items and progress = done / (descendants − cancelled). The same
function runs in the API and in tests; the web only formats it. Keeping it
pure makes the edge cases (no children, only cancelled children) one-line
unit tests.

## 3. Filtering a tree without losing the context

A search hit deep in the tree is useless without its path. The builder keeps a
node when it matches **or** when any descendant survived, and marks kept-for-
context nodes `matched: false` (the web greys them out). Rollups of a filtered
tree are computed over what is shown.

## 4. Reparenting reuses the edit path

`POST /work-items/:id/reparent` is a thin wrapper over the `parentId` edit, so
it inherits everything from S4-F1: the project tree lock, the row lock, the
rank check (no cycles), the explicit depth check, composite foreign keys, the
same 404 for foreign or missing parents, the optional `version` and the audit
entry ("Reparented WEB-W-3 under WEB-W-1"). A second endpoint for the same
mutation would have been a second place to forget a check.

## 5. Exercises

1. Cache rollups in a column updated in the same transaction as each change.
   Which writes now need the tree lock?
2. Stream the tree for very large projects: what breaks in the filter rule?
3. Add keyboard navigation (arrow keys) following the WAI-ARIA tree pattern.
