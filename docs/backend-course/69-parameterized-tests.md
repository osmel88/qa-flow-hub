# 69 — Parameterized tests: one definition, many frozen executions

Phase S7-F3. Code: `packages/shared/src/test-design/test-parameters.contracts.ts`,
`apps/api/src/modules/test-design/test-design.service.ts` (`replaceParameters`,
`importDataset`, `exportDataset`) and `apps/api/src/modules/test-runs/test-runs.service.ts`
(`expandRunCase`).

## 1. Where the definition lives

Parameters and dataset rows are JSON columns on `test_cases`. They are part
of the case definition, so saving them bumps `version` like steps do. A
separate table would add joins and locks for data that is always read and
written as a whole; JSON validated by one shared Zod schema is enough.

## 2. Expansion freezes values, not references

`expandRunCase` turns a case with N rows into N `test_run_cases`, each with
`iterationKey` (the row id), a label, an index and `parameterValues`: the
values after defaults were applied. The execution never points back to the
live row, so editing or deleting the row later cannot change history.

The old unique key `(testRunId, testCaseId)` became
`(testRunId, testCaseId, iterationKey)`. A plain case uses `''` as key, which
keeps "a case appears once in a run" true for unparameterized cases.

## 3. Immutability in the database

`test_run_cases_frozen()` is a `BEFORE UPDATE` trigger that rejects changes to
the snapshot, version or iteration columns. Status and assignment can still
change; what was executed cannot, whatever code (or SQL session) tries.

## 4. Concurrency

`replaceParameters` locks the case row (`SELECT … FOR UPDATE`) and compares
the `version` sent by the editor. Two editors starting from the same version:
one wins, the other gets 409 and reloads. Results on different rows touch
different `test_run_cases`, so they never contend.

## 5. CSV round trip

Export writes `_id`, `_label` and one column per parameter, with formula
neutralization. Import parses every cell with `parseParameterCell` before
writing anything and then goes through `replaceParameters`, so the same
validation, lock, version check and audit apply. Keeping `_id` is what makes
export → import an identity.
