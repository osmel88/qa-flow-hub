# 68 — Test cycles: snapshots of snapshots

Phase S7-F2. Code: `apps/api/src/modules/test-plans/test-cycles.*`,
`packages/shared/src/test-plans/test-cycle.contracts.ts`.

## 1. A cycle copies a version, not a live list

A plan freezes its scope in versions. A cycle that starts copies the plan's
current version into its own `test_cycle_scope_items` and remembers which
version it was (`planScopeVersion`). Refreshing the plan later creates a new
version for future cycles; running and past cycles keep theirs.

## 2. Lock order

Cycle writes lock the cycle `FOR UPDATE` and then the plan `FOR SHARE`. Plan
writes only lock the plan, so the order never inverts and there is no
deadlock; a plan cannot close while a cycle write is in flight.

## 3. One run, one plan, one cycle

Unique indexes on `test_plan_runs.testRunId` and `test_cycle_runs.testRunId`
make "a run counts once" a database rule. Attaching a run of no plan to a
cycle attaches it to the plan in the same transaction.

## Exercises

1. Compare two cycles of the same plan case by case.
2. Refuse runs whose environment differs from the cycle environment.
