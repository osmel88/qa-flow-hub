# Stage 3 (S3) — Product consolidation on mocks and local services

Stage 2 closed with every external system behind a port and a mock
(`BillingProvider`, `SecretResolver`, the integration connectors). Stage 3
keeps it that way: each phase must be buildable and testable entirely locally,
and real providers are added later without touching domain logic.

Execution rule, unchanged:

> plan with decisions → approval → phase → validation (lint, typecheck, unit,
> integration, build, E2E, `db:migrations:check`) → commit → summary with debt
> → **stop** → explicit approval → next phase.

Hard constraints:

- No real external provider (GitHub, TestRail, Jira, Stripe, secret manager).
- No Redis and no new infrastructure without prior approval.
- Phases are picked from [`commercial-roadmap.md`](commercial-roadmap.md) in
  order, skipping items that need an external service.

## S3-F1 — Import & Export

Commercial roadmap items 1.2 and 1.3: import test cases from CSV and from a
TestRail CSV export file, and export cases, runs and the traceability matrix.

**Status: implemented.** Decisions (approved before implementation):

1. A persisted `ImportJob` (migration `import_jobs`): the dry run stores a
   normalized plan, the commit applies exactly that plan, and the history
   stays.
2. An import creates cases, suites, nested sections (`A > B > C`), steps and
   `verifies` links to **existing** requirements of the same project, from the
   `references` column.
3. Duplicates (same suite, section and normalized title, archived cases
   included) are skipped and reported as warnings; re-importing a file
   creates nothing.
4. CSV only, one row per case with steps on extra rows. No XML or XLSX.
5. New permissions `test_design.import` (qa_lead and above) and `data.export`
   (every role with read access; revocable per project with an override).
6. PDF through printable HTML views and the browser's "Save as PDF"; no
   server-side renderer (ADR 0016).
7. `csv-parse@7.0.3`, exact version, no transitive dependencies.

What shipped:

- `POST /projects/:projectId/imports?format=qaflow_csv|testrail_csv&suiteId|suiteName`
  (multipart, dry run), `GET .../imports`, `GET .../imports/:id`,
  `GET .../imports/limits`, `POST .../imports/:id/commit`.
- File guard (size before parsing, strict UTF-8, BOM, binary signatures,
  UTF-16, NUL), column/record/row/case/step/depth limits, row-by-row issues
  with `{ row, column, code, severity, message }`.
- Atomic commit under `pg_advisory_xact_lock('import:<org>:<project>')`,
  re-resolution inside the transaction, 409 `IMPORT_STALE` if the project
  changed since the dry run, one winner for concurrent commits, case-key
  counter reserved inside the same transaction, jobs expiring after 24 h and
  at most 20 `ready` jobs per project.
- `GET /projects/:projectId/exports/test-cases.csv`,
  `GET /test-runs/:id/export.csv` (from the run snapshots),
  `GET /traceability/matrix/export.csv`; formula neutralization, BOM, safe
  headers, audited with `AuditAction.export`.
- Web: import wizard with the dry-run report, disabled commit while there are
  errors, history; export buttons and printable views gated on
  `data.export`.

Not in this phase: persisting TestRail ids as external references, XML/XLSX,
scheduled or emailed reports, blocking manual case creation in archived
projects (debt 38).

## S3-F2 — Project visibility

Commercial roadmap item 2.1, closes debt 22: a member below
`organization_admin` must not discover a project they hold no grant in.

**Status: implemented.** No migration and no plan round, by request.

- `ProjectAccessService.visibleProjectIds()` / `isVisible()`; `effectiveRole()`
  throws `NotFoundError(resource)` without a grant; `projectsAllowing()`
  excludes projects without a grant; `authorizeProjectScope()` returns `null`
  for a hidden or missing project, and the lists answer an empty page.
- `GET /projects` filters by the visible ids before search and pagination, so
  `meta.total` never counts hidden projects.
- Grants accept `role: null` (access with the organization role); revoking a
  grant also drops the member's overrides in that project.
- Assignees of defects and run cases must see the project.
- Web: project access page shows who has no access and can give it; 404s
  refetch the project lists.
- Tests: `project-visibility.int-spec.ts` compares every project and entity
  read for a hidden project with a made-up id, for each role below admin, after
  revocation, reinvitation, archiving, a tenant switch and from another tenant.

## S3-F3 — API keys and report ingestion

Commercial roadmap items 2.2 and 2.3 (ADR 0018, debt 40). No plan round, by
request; debt 39 stays as it is.

**Status: implemented.**

- Migration `20261101100000_api_keys_ingestion`: enums `ApiKeyScope`,
  `IngestionFormat`; tables `api_keys` and `ingestion_reports` with RLS, no
  `DELETE` for the runtime role; `api_key_organization_for_prefix()`.
- `GET|POST /projects/:id/api-keys`, `POST /projects/:id/api-keys/:keyId/revoke`,
  `GET /projects/:id/ingestion-reports` (`api_keys.manage`).
- `POST /ingest/junit` and `POST /ingest/playwright` (multipart `file`, key in
  `Authorization: Bearer` or `X-Api-Key`, optional `runId`, `runName`,
  `environment`, `milestone`, `Idempotency-Key`).
- Audit: `create` and `revoke` on `ApiKey`, `execute` on `IngestionReport`.
- Web: API keys page with the token shown once, revocation and history.
- Tests: `ingestion.int-spec.ts`, `ingestion-limits.int-spec.ts`, parser and
  token unit tests, `api-keys-ingestion.e2e.spec.ts`.

## S3-F4 — Release as an entity

Commercial roadmap item 2.4 (ADR 0019, debt 41). No plan round, by request;
debt 39 stays as it is.

**Status: implemented.**

- Migration `20261115100000_releases`: enum `ReleaseStatus`, table `releases`
  with RLS and no `DELETE` for the runtime role, `test_runs.releaseId` with a
  composite FK `(releaseId, projectId)`.
- `GET|POST /releases`, `GET|PATCH /releases/:id`, `POST /releases/:id/start|release|archive`,
  `GET /releases/:id/summary`, `GET /releases/:id/traceability`
  (`releases.read` / `releases.manage`).
- Runs: `releaseId` on create/update and as a list filter; ingestion accepts
  `?release=<version>`; project analytics return `releases`.
- Audit: `create`, `update` and `archive` on `Release`; release changes of a run
  are in its `update` entry.
- Web: Releases list and create form, release detail (health, runs,
  traceability, transitions), run creation and filter by release.
- Tests: `releases.int-spec.ts`, `release.contracts.test.ts`,
  `ReleasesPage.test.tsx`, `releases.e2e.spec.ts`.

## S3-F5 — Notification outbox and retries

Commercial roadmap item 2.5, local part (ADR 0020, debt 42). Email stays on
the mock provider; Slack and real providers are out of scope.

**Status: implemented.**

- Migration `20261122100000_notification_outbox`: enum value `test_run_failed`,
  columns `payload`, `leaseUntil`, `nextAttemptAt`, index
  `(status, nextAttemptAt)`, function `claim_notification_deliveries()`.
- `NotificationOutboxWorker` (interval, batch, lease, backoff and attempt budget
  from `NOTIFICATIONS_*`); access and preferences re-checked at send time.
- `POST /notifications/:id/retry` (owners/admins, audited, 409 while leased or
  not failed); `nextAttemptAt` in `NotificationView`.
- Event `test_run.completed` → `test_run_failed` to the run creator and failed
  case assignees.
- Web: next retry time and "Retry now" in the organization ledger.
- Tests: `notification-outbox.int-spec.ts`, `template-payload.test.ts`,
  `notification-outbox.worker.test.ts`, `NotificationsPage.test.tsx`,
  `notifications.e2e.spec.ts`.

## S3-F6 — Multi-factor authentication (TOTP)

Stage 3 item 3.2 (ADR 0021, debt 43). SSO/SAML and SCIM (3.1) need an external
identity provider and stay out of scope.

**Status: implemented.**

- Migration `20261129100000_mfa_totp`: tables `mfa_totp_factors`,
  `mfa_recovery_codes`, `mfa_challenges`; columns `sessions.mfaAuthenticated`
  and `organizations.requireMfa`. No RLS: account-level tables.
- `/auth/mfa` (status), `setup`, `confirm`, `disable`, `recovery-codes`, and the
  public `verify` (auth rate-limit bucket); `POST /auth/login` returns a
  challenge for MFA accounts.
- `PATCH /organizations/current { requireMfa }` (owner, only from an MFA
  session); enforced by `ActiveOrganizationGuard` after membership.
- Web: two-step login with recovery-code fallback, Profile → MFA enrolment,
  Members → Security policy and MFA column, banner for blocked members.
- Tests: `totp.test.ts`, `env.schema.test.ts`, `mfa.int-spec.ts`, `mfa-app-role.int-spec.ts`,
  `LoginPage.test.tsx`, `mfa.e2e.spec.ts`.

## S3-F7 — Custom fields and defect workflow

Stage 3 item 3.3 (ADR 0022, debt 44).

**Status: implemented.**

- Migration `20261206100000_custom_fields_workflows`: enums
  `CustomFieldEntity`, `CustomFieldType`; tables `custom_field_definitions`
  and `defect_workflows` (RLS by organization, no `DELETE` for the app role);
  JSONB `customFields` with an object CHECK on `requirements`,
  `test_cases` and `defects`.
- `/custom-fields` (create, list, detail, patch, archive, restore) and
  `/defect-workflow` (get, put with `version`); permission
  `customization.manage`.
- `customFields` on create/update/view of requirements, test cases and
  defects, and the `customField` / `customFieldValue` list filter.
- Defect status changes follow the project's workflow (built-in graph when
  none is saved), with per-transition permission and required fields.
- Web: Customization page (fields and workflow editor), custom field inputs
  and summaries on Requirements, Test case editor and Defects; the Defects
  status menu offers only the project's transitions.
- Tests: `custom-field.contracts.test.ts`, `custom-fields.int-spec.ts`,
  `customization.e2e.spec.ts`.

## Related

- [`stage-2-roadmap.md`](stage-2-roadmap.md) — the stage this one builds on
- [`technical-debt.md`](technical-debt.md) — entry 38 for this phase
- [`adr/0016-printable-html-instead-of-server-pdf.md`](adr/0016-printable-html-instead-of-server-pdf.md)
- [`adr/0017-project-visibility-through-grants.md`](adr/0017-project-visibility-through-grants.md)
- [`adr/0018-api-keys-and-report-ingestion.md`](adr/0018-api-keys-and-report-ingestion.md)
- [`adr/0020-notification-outbox.md`](adr/0020-notification-outbox.md)
- [`adr/0021-totp-multi-factor-authentication.md`](adr/0021-totp-multi-factor-authentication.md)
- [`adr/0022-custom-fields-and-defect-workflow.md`](adr/0022-custom-fields-and-defect-workflow.md)
