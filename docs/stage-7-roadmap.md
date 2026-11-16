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
