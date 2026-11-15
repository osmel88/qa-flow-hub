# 72 — Flaky test detection: deterministic rules over a window

Phase S7-F6. Code: `packages/shared/src/flaky/flaky.contracts.ts`,
`apps/api/src/modules/flaky/*` and the migration
`20270425100000_flaky_test_detection`.

## 1. Derive, do not store

The status of a test is a function of its recent results. Storing it would
mean keeping a copy in sync with every write path (manual results, JUnit and
Playwright ingestion, deleted runs, deleted cases). Instead the service reads
the window and classifies it on every request. The only stored data are the
human decisions (marks), which cannot be derived.

## 2. One query builds the window

`FlakyRepository.samples()` runs inside `runInTransaction`, so
`app.current_organization` is set and RLS applies to `qaflow_app`. A
`ROW_NUMBER() OVER (PARTITION BY testCaseId ORDER BY executedAt DESC)` keeps
the newest 20 `passed`/`failed` results per case, joined to the run (project,
deleted runs out) and to `ingestion_reports` to tell automated runs from
manual ones. Manual and automated results already share `test_results`, so
no extra write hook was needed.

## 3. The classifier is a pure function

`analyzeFlakiness()` lives in the shared package: the API uses it and its
unit tests pin every rule. Its steps:

1. sort, keep the newest 20, reverse to chronological order;
2. walk the results keeping the previous result per dataset row; compare
   only when the case version is the same, and count a flip when outcomes
   differ;
3. classify: fewer than 5 → `insufficient_data`; no failure → `stable`;
   ≥ 2 flips and flip rate ≥ 0.25 → `flaky`; last 3 failed (case or one row)
   → `failing`; ≤ 1 flip ending in a pass → `stable`; otherwise `suspect`.

Why these numbers: 5 results is the smallest sample in which a 0.25 flip
rate means at least one real alternation beyond a single regression or fix;
20 keeps the window recent enough to forget fixed problems; 2 flips separate
"failed once" (a regression or a fix is a single flip) from alternation.

## 4. Why versions and rows break comparisons

A failure followed by a pass after editing the case is the edit working, not
instability. And two dataset rows can legitimately have different outcomes
(one currency broken, the other fine); comparing them would flag a stable
failure as flaky. Keying comparisons by `(iterationKey, caseVersion)` removes
both false positives.

## 5. Human marks are append-only

`test_case_flaky_marks` only accepts inserts (`REVOKE UPDATE, DELETE`). The
newest row is the current mark. `effectiveFlakyStatus()` applies it: a
confirmation always reads flaky; a dismissal hides `flaky`/`suspect` only
until a flip newer than the dismissal, so a dismissal cannot hide a problem
that comes back. The API returns both `status` and `detectedStatus`.

## 6. Isolation

The list goes through `authorizeProjectScope` (a hidden project lists
nothing); the detail and the mark load the case with the tenant scope and
call `assertRouteAccess`, so another tenant, a hidden project or a deleted
case is a 404. The mark's foreign key `(testCaseId, projectId)` makes a
cross-project mark impossible even for a buggy caller.

## Exercises

1. Make the window size a per-project setting; what has to change in the
   query and in the docs?
2. Add a materialized projection updated on result insert and compare its
   consistency guarantees with the derive-on-read approach.
