# 70 — Test case versioning: history the database guarantees

Phase S7-F4. Code: `packages/shared/src/test-design/test-case-version.contracts.ts`,
`apps/api/src/modules/test-design/test-design.service.ts` (`updateCase`,
`restoreVersion`, `diffVersions`) and the migration `20270411100000_test_case_versions`.

## 1. A version is a row, not a number

Before S7-F4 a case only had a counter. The run snapshot remembered what was
executed, but nobody could ask "what did version 3 say?". Now each version is
an immutable row in `test_case_versions` with the full content. The app role
has no `UPDATE` or `DELETE` on the table, so history cannot be edited even by
a bug in the API.

## 2. What counts as content

Only fields that change what a tester does create a version: title,
description, preconditions, expected result, type, priority, steps,
parameters and dataset. Status, tags or section are bookkeeping. `updateCase`
compares the input with the locked row (`changed()` and `sameSteps()`) and
only then increments `version` and calls `appendVersion`.

## 3. Optimistic locking on top of a row lock

Every edit runs `SELECT … FOR UPDATE` on the case, then compares the
`version` the editor loaded. The lock serializes writers; the version check
turns "last writer wins" into a 409 for the writer who never saw the other
change.

## 4. Pointing at the exact version with triggers

Executions, results and frozen scope rows get `testCaseVersionId`. Instead of
changing every insert path (runs, ingestion, plans, cycles, imports), a
`BEFORE INSERT` trigger resolves the row from `(testCaseId, caseVersion)`
through `test_case_version_ensure()`. A deferred constraint trigger on
`test_cases` guarantees that any transaction that creates a case or moves
its version commits with that version recorded. Code that forgets still
produces correct data.

## 5. Restore is a new version

Restoring version 1 of a case at version 3 writes version 4 with the content
of version 1 and `restoredFromVersion = 1`. Nothing older changes, so a run
that executed version 3 still cites version 3.
