# 51 — Ordering a shared list: ranks, gaps and locks

Phase S4-F2 (ADR 0024). Code: `WorkItemsService.move/backlog/bulkUpdate`,
`WorkItemsRepository.lockBacklog/neighbour/renumber/lockMany`, the migration
`20261220100000_work_item_backlog_rank` and `apps/web/src/pages/BacklogPage.tsx`.

## 1. Why "save the whole order" is wrong

The naive drag-and-drop API receives the full list of ids in the new order.
Two people dragging at the same time each send a full list computed from what
they saw, and the last request silently undoes the first. A _relative_ move
("put X before Y") composes: applied one after the other, both moves survive.

## 2. Gapped integers

Dense positions (1, 2, 3) force a move from the bottom to the top to rewrite
every row. Leaving gaps (1024, 2048, …) lets a move pick the midpoint between
two neighbours and write a single row. Each move into the same gap halves it;
after about ten, no integer is left. Then `renumber()` spreads the project
back to steps of 1024 in one statement:

```sql
UPDATE work_items w SET rank = r.position * 1024
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY rank, "createdAt", id) AS position
      FROM work_items WHERE … AND "deletedAt" IS NULL) r
WHERE w.id = r.id;
```

The integration test `renumbers when a gap runs out` squeezes twelve items
into one gap and checks that order and uniqueness hold.

## 3. One lock, one order

Computing a midpoint reads two rows and writes a third: two concurrent moves
could pick the same midpoint. The backlog advisory lock makes the read and
the write atomic per project. Note the lock hierarchy now: tree lock (S4-F1)
→ backlog lock → row locks. Every path takes them in that order or skips
some, never the reverse — that is how deadlocks are avoided by design rather
than by luck.

## 4. Bulk edits: all or nothing, in a stable order

`lockMany()` locks the selected rows `ORDER BY id`. Two bulk edits over the
same rows in different orders would otherwise each hold half the rows and
wait for the other half: a deadlock. With a global order the second simply
waits. If any id is missing, deleted or from another project, the whole batch
is refused with the same 404 a made-up id gets.

## 5. Grouping without recursive SQL

Grouping by epic or feature needs each item's ancestor of that type. The
service loads `id, parentId, type` of every live item once and walks up in
memory; the ranked hierarchy bounds the walk to four steps.

## 6. Exercises

1. Replace the advisory lock with `SERIALIZABLE` isolation and a retry loop.
   What do you gain and what do you lose?
2. Make ranks per release instead of per project. Which queries change?
3. Add an "undo last move" that stays correct when someone else moved in
   between.
