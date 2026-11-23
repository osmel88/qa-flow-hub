# Stage 7 roadmap — QA planning

Stage 7 builds the QA planning layer above suites and runs. Everything stays
local; no external provider is involved.

## S7-F1 — Test Plans

- 1 migration: `test_plans` (project, name unique per project ignoring
  case, description, status, owner, optional release, start/end dates,
  `scopeVersion`, `frozenAt`, lifecycle timestamps, `version`), join tables
  `test_plan_environments`, `test_plan_suites`, `test_plan_cases` (direct
  cases) and `test_plan_runs` (a run belongs to at most one plan), and
  `test_plan_scope_items` (the frozen scope, append-only). Every foreign key
  carries `projectId`, so a suite, case, run, release or environment of
  another project or tenant is refused by the database; the service answers
  404 first. RLS on all of them; the app cannot delete plans nor edit frozen
  scope rows.
- Lifecycle: `draft` → `active` → `completed` → `archived`; draft and active
  can be cancelled, a draft can be archived directly. Invalid moves answer
  422; completed, cancelled and archived plans are read-only (409).
- Scope: suites (all their live cases) plus direct cases. Starting the plan
  freezes it as scope version 1; afterwards suite/case edits of the plan are
  refused (409) and changes to the suites do not alter it.
  `POST /test-plans/:id/scope/refresh` appends a new version; older versions
  stay stored.
- Progress (`GET /test-plans/:id/progress`, one REPEATABLE READ snapshot):
  per scope case, the latest executed result among the plan's live runs;
  passed/failed/blocked/skipped/untested counts, completion, pass rate,
  coverage (scope cases present in a plan run) and related defects (from the
  plan runs or the scope cases).
- Concurrency: every write locks the plan (`FOR UPDATE`) and accepts an
  optional `version` (409 on mismatch); starting twice freezes once.
- API: `/test-plans` list (filters status, release, environment, owner,
  search; archived hidden unless asked), create, get, `PATCH`, `start`,
  `complete`, `cancel`, `archive`, `scope/refresh`, `runs` attach/detach.
  Permissions: `testruns.read`; `testruns.create` to create, edit, refresh
  and attach runs; `testruns.manage` for lifecycle actions. All audited.
- Web: Test plans page (filters, create) and plan detail (scope, lifecycle,
  runs, progress, cases and defects).
- Tests: `test-plans.int-spec.ts`, `test-plan.contracts.test.ts`,
  `test-plans.e2e.spec.ts`.

## S7-F2 — Test Cycles

- 1 migration: `test_cycles` (plan, name unique per plan ignoring case,
  description, status, owner, optional environment and release, dates,
  `frozenAt`, `planScopeVersion`, lifecycle timestamps, `version`),
  `test_cycle_runs` (a run belongs to at most one cycle) and
  `test_cycle_scope_items` (append-only). Composite `projectId` foreign keys
  and RLS on all of them; the app cannot delete cycles nor edit frozen scope.
- Lifecycle: `planned` → `active` → `completed` → `archived`; planned and
  active can be cancelled, a planned cycle can be archived directly. Invalid
  moves answer 422; finished cycles and cycles of a closed plan are
  read-only (409).
- Scope: a planned cycle follows its plan. A cycle starts only inside an
  active plan and copies the plan's current frozen scope version; later plan
  refreshes do not alter it. Once started, environment and release are
  frozen too (409).
- Target: the environment must belong to the project and, if the plan lists
  environments, be one of them; the release defaults to the plan's.
- Runs: a cycle run must belong to the cycle's plan; a run of no plan is
  attached to the plan as well, a run of another plan or cycle answers 409.
  A plan cannot detach a run that a cycle uses.
- Progress (`GET /test-cycles/:id/progress`): same derivation as plans, over
  the cycle's runs only; defects found in those runs.
- API: `/test-cycles?testPlanId=` (filters status, environment, release,
  owner), create, get, `PATCH`, `start`, `complete`, `cancel`, `archive`,
  `runs` attach/detach. Same permissions as test plans. All audited; a cycle
  or plan of another tenant or a hidden project answers 404.
- Web: Cycles section in the plan detail and a cycle detail page.
- Tests: `test-cycles.int-spec.ts`, `test-cycle.contracts.test.ts`,
  `test-cycles.e2e.spec.ts`.

## S7-F3 — Parameterized Testing

- 1 migration: `test_cases.parameters` and `test_cases.dataset` (JSONB,
  versioned with the case) and, on `test_run_cases`, `iterationKey`,
  `iterationLabel`, `iterationIndex` and `parameterValues`. The run-case
  uniqueness becomes `(testRunId, testCaseId, iterationKey)`; a plain case
  keeps `iterationKey = ''`. A trigger rejects any update of the snapshot,
  the version or the dataset row of an execution, from any code path.
- Parameters: name (letters, digits, `_`, unique ignoring case), type
  (`string`, `number`, `boolean`, `date` as `YYYY-MM-DD`), required, default
  and description. Rows: stable id, label and typed values. Validation is
  shared by the API and the editor: wrong types, unknown columns, duplicate
  names or row ids and missing required values (without default) answer 400.
- `PUT /test-cases/:id/parameters` replaces the whole definition and bumps
  the case version; `version` makes a stale editor fail with 409. Edits lock
  the case row. Audited.
- Expansion: including a case with a dataset in a run creates one execution
  per row with the resolved values (defaults applied) and the parameter
  definition in the snapshot. Each execution has its own append-only results.
- Filters on `GET /test-runs/:id/cases`: `testCaseId`, `datasetRowId` and
  `parameterized=true|false`.
- Plans and cycles count a parameterized case once, with the worst status of
  its rows in the newest executed run.
- CSV: `GET /test-cases/:id/dataset/export.csv` (`data.export`) writes `_id`,
  `_label` and one column per parameter; `POST /test-cases/:id/dataset/import`
  (`test_design.import`) types every cell, rejects the whole file on the first
  bad line and keeps row ids, so export → import is a round trip.
- Web: parameters and dataset editor on the case page (CSV import/export
  included); the run page shows the row label, the values used, the values
  next to the latest result, and a dataset-row filter.

## S7-F4 — Test Case Versioning

- 1 migration: `test_case_versions` (append-only for the app, RLS, composite
  `projectId` foreign key) holds an immutable copy of title, description,
  preconditions, expected result, type, priority, steps, parameters and
  dataset, with author, timestamp, optional reason and `restoredFromVersion`.
  `test_run_cases`, `test_results`, `test_plan_scope_items` and
  `test_cycle_scope_items` gain `testCaseVersionId`; results also get
  `caseVersion`. Insert triggers fill them on every write path, and a deferred
  constraint trigger records the version of any case created or bumped
  outside the service (imports, seeds, scripts).
- Backfill: every case gets its current version; older executed versions are
  recovered from run snapshots (without description and dataset, which the
  snapshot never stored).
- Only content creates a version; status, tags, section, estimate and custom
  fields change in place. Saving identical steps is not a version. Every edit
  locks the case row and accepts `version` (409 when stale) and
  `changeReason`.
- API: `GET /test-cases/:id/versions`, `GET /test-cases/:id/versions/:version`,
  `GET /test-cases/:id/versions/diff?from=&to=` (`test_design.read`) and
  `POST /test-cases/:id/versions/:version/restore` (`test_design.write`),
  which copies the old content into a new version and is audited as
  `restore`. A deleted case answers 404; its versions and executions stay.
- Runs, results, plan and cycle progress show the exact version; the
  traceability matrix keeps linking the logical case and adds
  `lastExecutedVersion`.
- Web: version history on the case page (author, date, reason, view, compare,
  restore with reason), change reason on save, executed version on runs and
  results with a link to that version, version column in plan and cycle cases
  and in the traceability matrix.

## S7-F5 — Exploratory Testing

- 1 migration: `exploratory_sessions` (title, charter, owner, status,
  optional environment, release, test plan and test cycle, timebox, notes,
  risks, link/attachment metadata, start/pause/end and active duration,
  `version`), `exploratory_session_events` (append-only timeline),
  `exploratory_findings` (kind, severity, optional defect) and link tables to
  work items and defects. Composite `projectId` foreign keys, RLS on all;
  `defects` gains a unique `(id, projectId)`.
- Lifecycle: `planned` → `active` ⇄ `paused` → `completed` → `archived`;
  planned, active and paused can be cancelled, planned can be archived.
  Invalid moves answer 422. A tester runs one active session per project
  (partial unique index, 409).
- Immutability: triggers refuse any change to a completed or cancelled
  session except archiving, any change to an archived one, and findings,
  notes or links outside an open session. The API answers 409 first.
- Findings are recorded while the session is active or paused; one can
  become a new defect (`defects.create`, severity copied, environment name,
  audited) or point at an existing defect of the same project, once.
- Metrics, derived on read: active duration (pauses excluded), findings by
  kind and severity, defects created, defects related, notes.
- API `/exploratory-sessions`: list (filters), create, view, edit, start,
  pause, resume, complete, cancel, archive, notes, findings, finding → defect,
  finding ↔ defect, work item and defect links. Reading `testruns.read`;
  running and recording `testruns.execute`; cancel and archive
  `testruns.manage`.
- Web: Exploratory testing page (filters, new session) and session page
  (actions, notes, risks, links, findings, defects, work items, timeline,
  metrics).

## S7-F6 — Flaky Test Detection

- 1 migration `20270425100000_flaky_test_detection`: `test_case_flaky_marks`
  (append-only manual marks: `flaky`, `not_flaky`, `cleared`, with reason,
  author and time; composite `(testCaseId, projectId)` foreign key; RLS;
  `UPDATE`/`DELETE` revoked from `qaflow_app`) and an index
  `test_run_cases(organizationId, testCaseId)` for the window query. No
  derived state is stored.
- Rules (constants in `packages/shared/src/flaky/flaky.contracts.ts`, no
  environment variable):
  - **Signal:** only `passed` and `failed` results. `blocked`, `skipped` and
    `untested` say nothing about the test and are ignored.
  - **Window:** the latest **20** signal results of the test case, over runs
    that are not deleted, manual and automated alike (a run is automated
    when an ingestion report created it). Deleted test cases are left out.
  - **Minimum:** fewer than **5** signal results → `insufficient_data`,
    never flaky.
  - **Comparisons and flips:** each result is compared with the previous one
    of the same dataset row (`iterationKey`) and the same case version. A
    flip is a comparison whose outcome differs. Outcome changes across a
    version change are explained by the edit and are not compared; dataset
    rows never compare with each other. `flipRate = flips / comparisons`.
  - **Classification**, in this order:
    1. `insufficient_data`: fewer than 5 results;
    2. `stable`: no failure;
    3. `flaky`: at least **2** flips and a flip rate of at least **0.25**;
    4. `failing` (stable failure): the last **3** results of the case, or of
       one dataset row, failed;
    5. `stable`: at most one flip and the last result passed (a fix);
    6. `suspect`: any other mix of passes and failures.
  - **Manual marks:** the newest mark is current. `flaky` always reads
    flaky (confirmed). `not_flaky` turns a detected `flaky` or `suspect` into
    `stable` (dismissed) until a flip happens after the mark. `cleared`
    removes the effect. The detected status is always returned too.
  - **Recalculation:** on every read, from the results at that moment. A new
    manual result, an ingestion or a deleted run changes the status at once;
    there is no job, cache or stored status to drift.
- API `/flaky-tests`: list (filters `status`, `source=all|manual|automation`,
  `suiteId`, `q`, `marked`; sort `status|flipRate|failRate|executions|
lastExecutedAt|key`, `order`), detail with rules, history (result, run,
  run case, source, version, dataset row, flip) and mark history, and
  `POST /flaky-tests/:testCaseId/marks`. Reading `testruns.read`; marking
  `test_design.write` (audited). A case of another tenant, of a hidden
  project or deleted answers 404.
- Web: Flaky tests page (filters, sorting, metrics) and a case stability
  page (rules, metrics, source filter, history linked to runs, marks).

## Login findings (between S7-F6 and S7-F7)

- **Show/hide password:** `PasswordField` in `packages/ui` (login, register,
  reset). Only `type` changes; the toggle is a `<button type="button">` with
  `aria-label` "Show password"/"Hide password", `aria-pressed` and
  `aria-controls`.
- **Password recovery:** migration `20270502100000_password_reset`
  (`password_reset_tokens`, account level like `sessions`, no RLS; enum values
  `NotificationType.password_reset` and `AuditAction.password_reset`).
  - `POST /auth/password/forgot` always answers 202 `{ accepted: true }`. A
    token is 32 random bytes (base64url); only its SHA-256 is stored. It
    expires in 30 minutes, works once, and a newer request invalidates older
    ones. At most 3 links per account per 15 minutes (extra requests are
    silently dropped). Both routes share the per-IP auth rate limit
    (`AUTH_RATE_LIMIT_MAX`).
  - The email goes through the notifications ledger (organization `null`, not
    opt-out). With `EMAIL_PROVIDER=mock` and `NODE_ENV` other than
    `production`, the response also carries `mockResetUrl` (or `null`) so the
    flow can be finished without a mailbox, as the invitation link is shown to
    the inviter. Production never returns it.
  - `POST /auth/password/reset` spends the token with a guarded `updateMany`
    (single use, also under concurrency), sets the password, clears the
    lockout counters, invalidates other links, revokes every session
    (`revokedReason = 'password_reset'`), audits both steps and sends the
    "password changed" email. A spent, expired, superseded or unknown token
    answers 400 with one message.
  - Web: "Forgot password?" on Login, `/forgot-password`, `/reset-password`
    (the token is removed from the address bar on load).
- **i18n:** `apps/web/src/i18n` (provider, `t()`, catalogs `en` and `es`,
  fallback to English, choice stored in `localStorage` `qaflow.locale`,
  `<html lang>` follows it). Selector in the app header and on every public
  auth screen. Translated: Login (incl. MFA step), Register, password
  recovery, main navigation and header. Pending screens: see
  `docs/frontend-architecture.md` § Internationalization.
- **Project key:** `ProjectsPage` validates with the shared `projectKeySchema`
  while typing and shows `PROJECT_KEY_RULE` ("2 to 8 uppercase letters or
  digits, starting with a letter.") as hint and error; Create project stays
  disabled until Name and Key are valid. The API keeps the same schema.

## Web i18n completion (between S7-F6 and S7-F7)

- Every product screen and shared component uses `t()` keys with English
  and Spanish catalogs split by screen (`apps/web/src/i18n/messages/<locale>/`).
  No page is duplicated and no screen branches on the language.
- Domain values go through `humanize()` → `valueLabel()` (`value.<raw>`).
- `packages/ui` defaults (`DataState`, `PasswordField`) come from
  `UiStringsProvider`, filled by `I18nProvider`.
- Shared Zod messages shown by the Web are mapped centrally in
  `i18n/validation.ts`. The project key rule is a catalog key
  (`projects.keyRule`); the API keeps `PROJECT_KEY_RULE`.
- API error messages stay English (debt 69). No API, migration or
  environment change.

## S7-F7 — QA Metrics Dashboard

A per-project page that consolidates the QA data that already exists. Nothing
is stored: every number is computed on read from the same tables (and, where
one exists, the same function) that feed the plan, cycle, run, defect,
exploratory and flaky screens. Route: `GET /projects/:projectId/qa-metrics`,
permission `analytics.read` (the dashboards permission), `@ProjectScoped`, so a
hidden project answers 404 and a project-level revoke 403.

### Filters

- **Window** `from`/`to`/`bucket`: same rules as the analytics dashboards
  (default last 30 days, at most 366 days, bucket sized to the window).
- **Test plan / Test cycle / Release / Environment** (ids of the project; an id
  of another project or tenant answers 404). They narrow the runs in scope:
  - plan: runs attached to the plan (`test_plan_runs`) or to one of its cycles;
  - cycle: runs attached to the cycle (`test_cycle_runs`);
  - release: runs with that `releaseId`;
  - environment: runs whose free-text `environment` equals the environment
    name (case-insensitive) or that belong to a cycle in that environment.
    The same filters narrow plans, cycles and exploratory sessions by their own
    `releaseId`, `environmentId`, `testPlanId` and `testCycleId`.

### KPIs and how each is computed

- **Runs in scope:** non-deleted, non-aborted runs created before `to` and not
  completed before `from` (the analytics definition), after the filters.
- **Execution** (`executionKpis`, shared with the analytics dashboard): the
  latest status of every run case in scope. `planned` = run cases;
  `executed` = not `untested`; `pending` = `untested`; verdicts = passed +
  failed + blocked; pass/fail/blocked rate = each / verdicts; progress =
  executed / planned.
- **Minimum sample:** rates are `null` (shown as "not enough data") while the
  scope has fewer than 5 verdicts (`QA_METRICS_MIN_VERDICTS`); counts are
  always shown.
- **Trend:** per bucket, every result recorded (`test_results.executedAt`) on
  runs in scope: passed, failed, blocked and pass rate (null for a bucket with
  no verdicts).
- **Plan and cycle progress:** the existing plan and cycle progress
  (`computePlanProgress` over the frozen or live scope) for the plans and
  cycles alive in the window, at most 20 of each, newest first.
- **Open defects by severity:** non-deleted defects in an open status
  (`open`, `triaged`, `in_progress`, `reopened`). Without a plan, cycle,
  release or environment filter: every open defect of the project; with one:
  only defects raised from a run in scope.
- **Defect density:** defects raised from runs in scope during the window /
  executed run cases, shown only with at least 20 executed run cases
  (`QA_METRICS_MIN_EXECUTED_FOR_DENSITY`); otherwise `null`.
- **Flaky tests:** counts by effective status (detected status plus the
  current manual mark) with the S7-F6 rules over each case's newest 20
  results. Flaky detection is per test case over its own window, so it does not
  follow the time window or the run filters.
- **Flaky evolution:** at the end of each bucket, the number of cases whose
  detected status (S7-F6 rules over the newest 20 results before that instant,
  without manual marks) is `flaky`, `suspect` or `failing`.
- **Exploratory:** sessions alive in the window (created before `to`, not
  ended before `from`) after the filters: count by status, total active
  duration of ended sessions, findings by kind and severity, and defects
  created from findings.

### Isolation

Every statement filters by `organizationId` and the authorized `projectId` and
runs inside a tenant transaction, so RLS applies under `qaflow_app`.

## S7-F8 — Release Readiness Report

**Goal:** one release-scoped answer to "can we ship?", derived on every read
from the QA evidence that already exists, with the reason behind it. Nothing
is stored: the report is recomputed from quality gates, release execution,
plans and cycles, defects, traceability, flaky detection and exploratory
testing.

### API

`GET /api/v1/releases/:id/readiness` — project-scoped (`@ProjectScoped()`),
permission `analytics.read`. The release is loaded through
`ReleasesService.get()`, so a release of another organization or project (or
a project whose `analytics.read` was revoked) answers 404/403 exactly like
the other release routes. The project is resolved from the release, never
from a client-supplied id.

The response (`ReleaseReadinessView` in `packages/shared`) carries:
`release`, `project`, `decision`, `reasons`, `blockers`, `warnings`,
`metrics` (quality gates, execution, plans, cycles, defects, requirements,
flaky, exploratory), `thresholds` and `computedAt`. Each reason has a stable
`code`, the `source` it comes from (`quality_gates`, `execution`, `defects`,
`test_cycles`, `test_plans`, `requirements`, `flaky`, `exploratory`), a
`severity` (`blocker`, `warning`, `info`), a `count`, an English `message`
(for example `2 blocker/critical defects remain open.`) and the linked
`items` (id + label) that caused it. The Web translates by `code`.

### Sources reused

| Evidence       | Source of truth                                                                |
| -------------- | ------------------------------------------------------------------------------ |
| Quality gates  | `QualityGatesService.evaluate(releaseId)` (default environment)                |
| Execution      | `ReleasesService.summary()` → `executionKpis()`, `sampledRates()`              |
| Plans / cycles | plans/cycles with `releaseId`, `TestPlansService/TestCyclesService.progress()` |
| Defects        | non-deleted defects raised from runs of the release                            |
| Requirements   | `ReleasesService.traceability()` rows                                          |
| Flaky tests    | `FlakyService.views()` (S7-F6 rules + manual marks) for release cases          |
| Exploratory    | sessions with `releaseId` and their findings                                   |

### Decision rules (`decideReadiness()`, deterministic)

Thresholds: `READINESS_MIN_VERDICTS = 5` (= `QA_METRICS_MIN_VERDICTS`) and
`READINESS_MAX_FAILED_RATE = 10` (%). Rates are `null` below 5 verdicts.

**Blockers** (any one → `NO-GO`):

1. `required_gate_failed` — a required quality gate evaluates to `failed`.
2. `critical_defects_open` — an open (`open`, `triaged`, `in_progress`,
   `reopened`) defect with severity `blocker` or `critical`.
3. `failed_rate_above_threshold` — failed rate > 10% (only with ≥ 5 verdicts).
4. `cycle_incomplete` — a release cycle still `planned` or `active`.

**Warnings** (no blocker, ≥ 5 verdicts, any one → `GO WITH RISKS`):

`required_gate_pending`, `optional_gate_failed`, `high_defects_open` (open
`major`), `defects_reopened`, `tests_failed` (failed rate ≤ 10%),
`tests_blocked`, `executions_pending` (untested run cases),
`requirements_uncovered` (no linked case), `requirements_not_executed` (all
linked cases untested), `requirements_failing` (a linked case failed),
`flaky_tests` (effective status `flaky`, `suspect` or `failing`; a dismissed
mark removes the case), `plan_incomplete` (plan `draft` or `active`),
`exploratory_incomplete` (session `planned`, `active` or `paused`),
`findings_open` (bug finding without a defect).

**Order:**

1. any blocker → `NO-GO` (blockers win even with too few verdicts);
2. fewer than 5 verdicts → `INSUFFICIENT DATA` (`not_enough_verdicts`);
3. any warning → `GO WITH RISKS`;
4. otherwise → `GO` (`all_checks_passed`).

### Web

Release Detail shows a "Release readiness" section (users with
`analytics.read`): decision badge, executive summary, blockers, warnings,
quality gates table, execution, plan/cycle progress, defects by severity,
requirements coverage, flaky tests and exploratory testing, in English and
Spanish. `/print/releases/:releaseId/readiness` is the printable report
(release, project, generation date, decision, reasons, KPIs, blockers,
warnings) using the existing print toolbar.

### Tests

- Shared: `release-readiness.contracts.test.ts` (every rule and the order).
- Integration: `release-readiness.int-spec.ts` (empty release, < 5 verdicts,
  GO, NO-GO by critical defects and failed rate, required vs optional gate,
  incomplete cycle, risks, other tenant 404, revoked permission 403).
- Web: `ReleaseReadiness.test.tsx` (EN/ES, sample threshold, printable).
- E2E: `release-readiness.e2e.spec.ts`.

No migration, no new environment variable.
