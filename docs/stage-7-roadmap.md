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
