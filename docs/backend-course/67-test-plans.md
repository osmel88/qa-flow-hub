# 67 — Test plans: freezing scope without freezing data

Phase S7-F1. Code: `apps/api/src/modules/test-plans/`,
`packages/shared/src/test-plans/test-plan.contracts.ts`.

## 1. Live scope vs frozen scope

A draft plan resolves its scope on every read: its suites' live cases plus
its direct cases. Starting it copies that list into `test_plan_scope_items`
with a scope version. From then on suites can change freely and the plan
still answers "what did we commit to test?". Refreshing appends a new
version instead of rewriting the old one.

## 2. Derive progress, store nothing

Results already live in runs. The plan only knows which runs are its own;
`computePlanProgress()` turns "latest executed result per scope case" into
counts, completion, pass rate and coverage on each read, inside one
REPEATABLE READ snapshot.

## 3. Composite keys keep the graph inside a project

Every link table references `(id, projectId)`. A case of another project
cannot be linked even by a bug in the service.

## 4. One lock, one version

All writes lock the plan row and compare `version`; two concurrent starts
freeze the scope once and the loser gets 422.

## Exercises

1. Create a run directly from the frozen scope.
2. Show the diff between two scope versions.
