# Stage 2 (S2) — Integrations and commercial readiness

This is the plan for the stage **after** the MVP. The document exists so that
each phase starts from a written contract instead of a conversation; each phase
records its delivery status at the top of its section once it is closed.

Execution rule, identical to the MVP and not negotiable per phase:

> phase → validation (lint, typecheck, unit, integration, build, E2E) → commit →
> summary with pending debt and architectural impact → **stop** → explicit
> approval → next phase.

Hard constraints for the whole stage:

- No data, token, account or resource belonging to any employer or third party.
- Jira and TestRail stay **mock** until dedicated accounts exist.
- GitHub may be real, with a **personal** account and the narrowest scopes.
- No Redis and no microservices without a demonstrated need and prior approval.
- No scope growth inside a phase. A discovery becomes a debt entry or a new
  phase, never an unannounced extra.
- The branch for S2 is created only after the MVP pull request is approved and
  merged.

## Phase order

| Phase  | Name                                              | Theme         |
| ------ | ------------------------------------------------- | ------------- |
| S2-F1  | Integration Settings — **delivered**              | Integrations  |
| S2-F2  | Jira Mock — **delivered**                         | Integrations  |
| S2-F3  | TestRail Mock — **delivered**                     | Integrations  |
| S2-F4  | GitHub Mock — **delivered**                       | Integrations  |
| S2-F5  | External Traceability — **delivered**             | Traceability  |
| S2-F6  | Email Notifications                               | Notifications |
| S2-F7  | File & Evidence Uploads                           | Evidence      |
| S2-F8  | Granular Permissions                              | Authorization |
| S2-F9  | Project KPI & Analytics Dashboard — **delivered** | Analytics     |
| S2-F10 | Production Readiness                              | Operations    |
| S2-F11 | Billing & Subscriptions                           | Commercial    |

KPI & Analytics was added after the stage was approved and is inserted **before**
Production Readiness and Billing, which shifts those two phases to F10 and F11.
No phase was removed or replaced.

S2-F4 was re-scoped before it started, from **GitHub Real** to **GitHub Mock**:
the real provider needs the credential store and the production hardening of
S2-F10, so it moves to a phase **after Stage 2** (see "Post-S2 — GitHub Real"
below). The mock keeps the phase count and the port contract; only the
implementation behind the port changes later.

## What the MVP already left in place

S2 is mostly filling in models that already exist, which is why it fits without
a redesign:

- `IntegrationConnection` — provider, `status`, `baseUrl`, non-secret `settings`,
  `secretRef`, `lastSyncAt`, `lastError`, unique per organization and provider.
- `ExternalReference` — polymorphic `entityType`/`entityId` → `provider`,
  `externalId`, `externalKey`, `externalUrl`, `metadata`, optional
  `connectionId`.
- `AttachmentMetadata` — with `storageKey` and `checksum` already reserved.
- `TraceabilityLink` — polymorphic, so new link types need no migration.
- Four isolation layers, an append-only audit log and the noop adapters.

The model changes each phase needs are listed inside that phase. Anything not
listed there is expected to require **no** migration.

---

## S2-F1 — Integration Settings

Per-organization configuration of Jira, TestRail and GitHub.

Each connection exposes: `provider`, `mode` (`mock` | `real`), `enabled`,
`status`, `baseUrl` where it applies, account/workspace/repository metadata,
`lastSyncedAt`, `lastConnectionTestAt`, non-sensitive configuration, and an
encrypted credential when one exists. Actions: **Test connection**,
**Connect**, **Disconnect**.

Rules:

- A secret is **never** returned to the frontend after being saved — not even
  partially reconstructable. The API returns presence and a masked hint only.
- `mode` is part of the connection, not an environment flag: one organization on
  a mock and another on the real provider must coexist.
- Every state change is audited; the credential value never enters the audit
  `changes` payload.
- `integrations.manage` is the permission gate (see S2-F8); until that phase
  exists, organization owner and admin only.

Model changes: add `mode`, `enabled`, `lastConnectionTestAt` and
`accountMetadata` to `IntegrationConnection`; add the credential store described
in S2-F4.

### Delivery (S2-F1)

Approved decision before implementation: **no credential storage in this phase**
("option A"). The credential store, encryption and any token intake belong to
S2-F4; F1 does not anticipate them.

What shipped:

- Migration `20260831110000_integration_settings`: `IntegrationMode` enum,
  `pending` status, `mode`, `enabled`, `accountMetadata`,
  `lastConnectionTestAt`; uniqueness becomes `(organizationId, provider)` — one
  connection per provider and organization. `secretRef` is kept and stays
  unresolved.
- Shared contracts in `packages/shared/src/integrations/`: provider and mode
  enums, `upsertIntegrationSchema` (non-sensitive `settings`/`accountMetadata`
  that **reject secret-like keys** such as `token`, `password`, `apiKey`), and
  the public `IntegrationConnectionView`, which exposes `hasCredential` only —
  never `secretRef`, a prefix or a masked hint. This is stricter than the
  "masked hint" the phase text allowed, and deliberate: there is nothing to
  mask yet, and a hint format decided now would bind S2-F4.
- API module `apps/api/src/modules/integrations/` (organization-scoped):
  `GET /integrations`, `GET|PUT /integrations/:provider`,
  `POST /integrations/:provider/{connect,disconnect,test-connection}`. Reading
  is open to every member; writing to `organization_owner` and
  `organization_admin`. Every write is audited without credentials.
- Provider availability table: Jira and TestRail accept `mock` only, GitHub
  `real` only; none is implemented yet, so **Connect** stores the configuration
  and leaves the connection `pending` + `enabled`, and **Test connection**
  records `lastConnectionTestAt` and answers with the phase that delivers the
  provider (S2-F2, S2-F3, S2-F4) instead of calling a fake adapter. No provider
  can reach `connected` in this build.
- `Settings → Integrations` screen with role-aware controls, unit tests, 21
  integration tests (isolation, roles, no secrets, availability) and one E2E
  spec (`apps/web/e2e/integrations.e2e.spec.ts`).

Debt recorded: entry 27 in `technical-debt.md`.

## S2-F2 — Jira Mock

A simulated Jira provider behind the same port as the real one: projects,
issues, stories/tasks, bugs, priorities, statuses, assignees, external IDs,
simulated create and update, and simulated synchronization with `Requirement`
and `Defect` through `ExternalReference`.

Rules: no real network call; the mock is deterministic and seedable so tests can
assert against it; latency and failure injection so the UI is built against a
provider that fails, which is the state a real one spends part of its time in.

### Delivery (S2-F2)

What shipped, all behind the existing `ISSUE_TRACKER_ADAPTER` port:

- `apps/api/src/integrations/jira-mock/`: `JiraMockStore`, an in-memory,
  per-organization Jira with two projects (`QA`, `WEB`), three users, five
  priorities, four statuses and three seed issues (`QA-1` story, `QA-2` bug,
  `WEB-1` task); ids and keys are allocated deterministically (`10103`/`QA-3`
  is always the first issue a test creates). `JiraMockIssueTrackerAdapter` maps
  the port's neutral vocabulary (`IssuePayload`, `IssueSummary`) onto it and
  honours two settings: `projectKey` (target project) and `simulateFailure`
  (`unreachable` fails everything, `write_failure` fails writes only).
- `IssueTrackerAdapter` grew `updateIssue`, `getIssue`, `listProjects`,
  `listIssues` and `describe`; `AdapterContext` carries `baseUrl`, so the mock
  can build `https://<site>/browse/KEY` links without a network call. The noop
  adapter implements the same surface and still fails honestly.
- Jira is now `implemented` in the availability table for `mock`: **Connect**
  reaches `connected`, **Test connection** runs the adapter's `check()`.
  TestRail and GitHub are untouched.
- `JiraSyncService` + `JiraSyncController` (`apps/api/src/modules/integrations/`):
  `GET /integrations/jira/{projects,catalog,issues}`,
  `GET /integrations/jira/references?projectId&entityType`,
  `POST /integrations/jira/sync/requirements/:id`,
  `POST /integrations/jira/sync/defects/:id`. Sync loads the entity through its
  tenant-aware repository, checks project access, creates the issue on the
  first call and updates it afterwards (or recreates it when the provider has
  lost it), and persists **one** `ExternalReference` per entity — moving the
  row to the new id and recording `previousExternalId` rather than leaving a
  stale second row. Requirement types map to story/task/bug; defects are
  always bugs and carry severity as a label. Provider failures mark the
  connection `error` with `lastError`; the next successful sync clears it.
- No column was added to `Requirement`, `Defect` or any business table; no
  migration.
- Web: a "Jira" column on Requirements and Defects (`JiraSyncCell`) that shows
  the linked key as a browse link and offers **Sync to Jira** / **Re-sync**;
  one references query per table, not per row.
- Tests: 9 adapter unit tests, 16 integration tests (`test/jira-sync.int-spec.ts`:
  browsing, create/update/recreate, defect lifecycle, tenant isolation, roles
  and project-level narrowing, simulated failures, recovery) plus the updated
  settings suite; the integrations E2E now connects Jira and syncs a
  requirement and a defect end to end.

Debt recorded: entry 28 in `technical-debt.md`.

## S2-F3 — TestRail Mock

Same shape, TestRail vocabulary: projects, suites, sections, test cases, runs,
results, external IDs, simulated import and synchronization with the internal
entities. No corporate account, no real credential.

Import is where the mapping decisions live: partial failure must be reported per
row, and a dry run must exist before anything is written.

### Delivery (S2-F3)

What shipped, all behind the existing `TEST_MANAGEMENT_ADAPTER` port:

- `apps/api/src/integrations/testrail-mock/`: `TestRailMockStore`, an
  in-memory, per-organization TestRail with two projects (`1` Quality
  Assurance, `2` Web Platform), TestRail's default statuses (plus `Skipped` as
  the custom one), priorities and case types, and a seed of suite `1`, root
  section `1`, cases `1`–`2`, run `1` with its tests and one passed result. Ids
  are allocated deterministically: the first suite a test creates is `2`, the
  first case `3`, the first run `2`, the first result `2`.
  `TestRailMockTestManagementAdapter` maps the port's neutral vocabulary
  (`SuitePayload`, `CasePayload`, `RunPayload`, `ResultPayload`) onto it and
  honours `settings.projectId` (target project) and `settings.simulateFailure`
  (`unreachable` | `write_failure`). Sections are matched or created by name
  inside the suite; they get no `ExternalReference` of their own.
- `TestManagementAdapter` was widened from import/export to neutral CRUD:
  `describe`, `listProjects/Suites/Cases/Runs`, `create/update/fetch` for
  suite, case and run, `addResult/fetchResult`. The noop adapter implements the
  same surface and still fails honestly.
- TestRail is now `implemented` in the availability table for `mock`:
  **Connect** reaches `connected`, **Test connection** runs `check()`. GitHub
  stayed pending until S2-F4.
- `TestRailSyncService` + `TestRailSyncController`:
  `GET /integrations/testrail/{projects,catalog,suites,cases,runs}`,
  `GET /integrations/testrail/references?entityType&projectId|testRunId`,
  `POST /integrations/testrail/sync/{test-suites,test-cases,test-runs,test-results}/:id`.
  A sync brings its dependencies with it — a case syncs its suite first, a run
  its suite and cases, a result its run — so nobody has to push the graph in
  order by hand. One `ExternalReference` per entity, moved (with
  `previousExternalId`) when the provider has lost the object; results are
  append-only on both sides, so a result reference is reused, never re-added.
  A run that spans several internal suites is pushed against the dominant one
  and the rest are listed in `metadata.skippedCases`; an empty run is refused.
- Model: `LinkableEntity` gained `test_suite` (migration
  `20260901090000_linkable_test_suite`, one `ALTER TYPE … ADD VALUE`). No
  column on `TestSuite`, `TestCase`, `TestRun` or `TestResult`.
- Web: `TestRailSyncCell` on the selected suite and on every case (Test cases),
  on every run (Test runs), and on the run header and the latest result of each
  case (execution screen). One references query per table, refreshed as a whole
  after any sync because a sync can create several references at once.
- Tests: 10 adapter unit tests, 21 integration tests
  (`test/testrail-sync.int-spec.ts`: browsing, create/update/recreate for each
  entity, dominant suite, result reuse, tenant isolation, roles and
  project-level narrowing, simulated failures and recovery), the settings suite
  updated, and a second E2E in `integrations.e2e.spec.ts` that connects TestRail
  and syncs case → run → result from the product screens.

Not delivered, on purpose: the import direction (TestRail → qa-flow-hub, with
per-row report and dry run). The adapter exposes `importCases`, but the phase
was approved as push-only sync; import belongs with S2-F5, which decides how an
externally-owned case shows up in the matrix. Debt recorded: entry 29.

## S2-F4 — GitHub Mock

A simulated GitHub, realistic enough to build and test the CI side of the
product with no account, no token and no network: repositories, branches,
workflows, workflow runs (status + conclusion, commit SHA, actor, event), jobs
with steps, artifact metadata and Playwright-shaped automated results whose
titles carry `@C-n` tags. The flow under test:

```text
GitHub Mock Repository → Workflow → Workflow Run → automated result
→ qa-flow-hub TestRun / TestResult → ExternalReference
```

The port is written so a `GitHubRealAdapter` can replace the mock without
touching the synchronization service.

### Delivery (S2-F4)

What shipped, all behind the `AUTOMATION_PROVIDER_ADAPTER` port:

- `apps/api/src/integrations/github-mock/`: `GitHubMockStore`, in-memory and
  per-organization, seeded with two repositories (`1` `acme/web-checkout`, `2`
  `acme/api-gateway`), branches with fixed SHAs, three workflows and five runs
  (`1001` success, `1002` failure, `1003` in progress, `1004` success on the
  other repository, `1005` cancelled), their jobs and steps, artifacts (one
  expired) and Playwright results: `@C-1`, `@C-2`, `@C-3` and one untagged
  smoke test per completed Playwright run. `GitHubMockAutomationProviderAdapter`
  honours `settings.repository` (default `acme/web-checkout`) and
  `settings.simulateFailure` (`unreachable` | `fetch_failure`: browsing works,
  results do not). URLs are built from `baseUrl` or `https://github.example.com`.
- `AutomationProviderAdapter` was widened from `fetchResults` to the neutral
  surface `check`, `listRepositories/Branches/Workflows/WorkflowRuns`,
  `fetchWorkflowRun`, `listJobs/Artifacts`, `fetchResults`, with neutral
  `External*` and `AutomatedResult` types (`caseTags`, `framework`, `file`,
  `project`). The noop adapter implements the same surface.
- GitHub is now `implemented` for `mock` in the availability table, with no
  base URL: **Connect** reaches `connected`, **Test connection** runs `check()`
  against the configured repository. `real` is refused with the reason.
- `GitHubSyncService` + `GitHubSyncController`:
  `GET /integrations/github/{repositories,branches,workflows,runs,jobs,artifacts,results}`,
  `GET /integrations/github/references?entityType&projectId|testRunId`,
  `POST /integrations/github/sync/test-runs/:id` (body → link or re-link a
  workflow run; no body → refresh what is linked) and
  `POST /integrations/github/sync/test-runs/:id/results` (import). A run keeps
  **one** `ExternalReference` to its workflow run (`externalKey`
  `owner/repo#runNumber`, metadata: workflow, branch, SHA, status, conclusion,
  event, actor), moved with `previousExternalId` when re-linked. Import
  resolves `@C-n` against the run's own cases (`<PROJECT>-C-n`), writes one
  append-only `TestResult` per match plus its reference in the same
  transaction, and returns every non-imported result with a reason
  (`no_case_tag`, `case_not_in_run`, `run_not_completed`, `already_imported`)
  instead of dropping it. Closed runs refuse imports. Provider errors set the
  connection to `error` with `lastError`; the next success clears it.
- Model: no migration. No column on `TestRun` or `TestResult`.
- Web: `GitHubRunPanel` on the execution screen (link picker repository →
  run, Refresh status, Import results with the skip report), origin line under
  an imported result, GitHub column on the Test runs table.
- Tests: adapter unit tests, 18 integration tests
  (`test/github-sync.int-spec.ts`: browsing, isolation, link / re-link /
  refresh, import and re-import, unmatched results, in-progress run, roles,
  both failure modes and recovery), the settings suite updated, and a third E2E
  in `integrations.e2e.spec.ts` that connects GitHub, links a run and imports
  its Playwright results from the product screens.

Not delivered, on purpose: anything real. Debt recorded: entry 30.

## Post-S2 — GitHub Real

Moved out of Stage 2 when S2-F4 became the mock. It starts only when two
things exist: a credential store (S2-F10 decides between an encrypted table
and an external secret manager) and production hardening.

Scope, unchanged: connect a personal account, choose authorized repositories,
read workflows and workflow runs, ingest Playwright reports — through the same
`AutomationProviderAdapter` the mock implements today.

This is the phase that touches security at the root: **the MVP has no
credential store.** `secretRef` points at a secret manager that does not exist
yet. It must deliver encryption with a key from the environment, token refresh,
revocation on disconnect, and a token that is never logged, never audited and
never returned. Least privilege: read-only scopes for the read-only features.

Model changes: an encrypted credential table (or a resolved external secret
manager), plus authorized-repository rows.

## S2-F5 — External Traceability

Extend traceability across the boundary, keeping `ExternalReference` generic and
provider-specific columns out of the business tables:

```text
Requirement  ↔ Jira Issue
TestCase     ↔ TestRail Case
TestRun      ↔ TestRail Run
Defect       ↔ Jira Bug
TestResult   ↔ GitHub Workflow Run
TestCase     ↔ Automated Test
```

The matrix must state where each fact came from: a requirement covered only by
an external case is a different claim from one covered internally, and merging
them silently makes the report unauditable.

### Delivery (S2-F5)

One consolidated, project-scoped view over the references the three mock
providers already write — no new provider, no new sync, no new column on a
business table:

- Model: `ExternalReference.projectId` (nullable, denormalised from the entity,
  migration `20260913120000_external_reference_project` with a backfill for
  the six entity types and for project-level rows) plus the index
  `(organizationId, projectId, provider)`. It exists so a project can list its
  references — including the ones whose entity is gone — with one query
  instead of six joins. Jira, TestRail and GitHub sync now stamp it on every
  write. The relation key stays `provider + entityType + entityId + externalId`.
- Contracts (`packages/shared/src/integrations/external-traceability.contracts.ts`):
  five statuses exactly as approved — `synced`, `linked`, `stale`, `missing`,
  `error` — and an `issues[]` list that says _why_ (`orphaned_entity`,
  `deleted_entity`, `archived_entity`, `entity_changed`, `provider_lost`,
  `duplicate_reference`, `shared_external_id`, `connection_missing`,
  `connection_disabled`, `connection_error`, `never_synced`, `not_linked`).
  Orphans and inconsistencies are therefore not a sixth status: an orphan is
  `error` + `orphaned_entity`, a duplicate is `error` + `duplicate_reference`.
  The row is provider-neutral (`externalKind` names the remote object: issue,
  bug, suite, case, run, result, workflow_run, automated_test).
- `ExternalTraceabilityService` derives the status from three parallel reads
  (references, entity snapshots that keep archived/deleted rows, connections):
  `error` when the connection is missing/disabled/in error, the entity is
  gone or the reference is duplicated or shares its external id with another
  entity; `stale` when the entity changed after `syncedAt` or the provider
  reported the object lost; `linked` when a link exists but was never synced
  (GitHub run links); `synced` otherwise; `missing` rows are generated for
  entities the configured providers are expected to track (Jira: requirement,
  defect; TestRail: suite, case, run; GitHub: run) and can be switched off
  with `includeMissing=false`. GitHub automated results are never `missing`:
  they only exist once imported.
- `POST /integrations/traceability/verify` probes every reference of a project
  through the existing adapters (`getIssue`, `fetchSuite/Case/Run/Result`,
  `fetchWorkflowRun`), records `verifiedAt` and `providerState` in the
  reference metadata (audit trail, never overwrites `previousExternalId`),
  updates the connection state and returns `present / lost / failed` counts.
  Read is open to project members; verify to planning roles. No cross-tenant
  or cross-project row can be reached: the repositories are tenant-aware and
  the project is checked with `assertRouteAccess`.
- Re-sync reuses what exists: the view says `canResync` and the web calls the
  provider's own sync endpoint (Jira/TestRail sync, GitHub re-link), which
  keeps the one-row-per-entity rule and `previousExternalId` from S2-F2..F4.
- Web: `/external-traceability` ("External references" in the navigation),
  separate from the internal `/traceability` matrix on purpose: Internal
  entity → Provider → External entity → External ID → Status (+ issues) →
  Last sync → Verified → Error → action. Filters: provider, entity type,
  status, "show entities not linked yet". "Verify with providers" button.
- Tests: 16 integration tests (`test/external-traceability.int-spec.ts`:
  three providers consolidated, imported GitHub results, filters, missing
  rows, stale after edit, archived and deleted entities, orphan, duplicate,
  shared external id, provider error, disconnected provider, running vs
  finished workflow, verify + lost objects, re-sync after provider loss,
  isolation between organizations, project permissions) and one E2E
  (`external-traceability.e2e.spec.ts`).

Not delivered, on purpose: KPI counts beyond the status totals the table
needs, a `TestCase ↔ Automated Test` confirmed binding (the mock still matches
by `@C-n` tag, entry 30), TestRail import. Debt recorded: entry 31.

## S2-F6 — Email Notifications

An `EmailProvider` abstraction with a sandbox/mock provider in development and
no irreversible dependency on a commercial vendor.

Initial cases: organization invitation, password recovery/change, test-run
assignment, defect assignment, and configurable important events.

This phase closes debt entries 4 and 10 (the invitation token is returned in the
API response today) and 12 (lazy invitation expiry). Sending must not happen in
the request path once it can fail, which is where the job runner (debt 3) gets
decided.

### Delivery (S2-F6)

Infrastructure only: every piece a real provider needs is in place, **no real
email is sent** and the only accepted `EMAIL_PROVIDER` is `mock`.

- Model (migration `20260920100000_notifications`): `Notification` — a
  persistent per-attempt ledger with nullable `organizationId` (account-level
  mail such as password changed), `recipientUserId`/`recipientEmail`, `type`,
  `templateKey`, `subject`, `status` (`pending | sent | failed | skipped`),
  unique `dedupeKey`, `provider`, `providerMessageId`, `attempts`,
  `attemptedAt`, `deliveredAt`, `failureReason`, `skipReason`, non-sensitive
  `metadata`. Bodies, tokens and links are never persisted.
  `NotificationPreference` — per user, global (not per organization):
  `emailEnabled`, `testRunAssignments`, `defectAssignments`, `statusChanges`,
  default on. RLS on `notifications` shows organization rows only to that
  organization and account-level rows only without an organization in context.
- Events (`apps/api/src/events/domain-events.ts`): typed
  `organization.invitation.issued`, `user.password.changed`,
  `test_run.cases.assigned`, `defect.assigned`, `defect.status.changed`,
  published by invitations, auth, test runs and defects through
  `DomainEventsPublisher` (in-process `emitAsync`; a listener failure is
  logged, never returned to the business call). No other mutation emails.
- Provider (`apps/api/src/integrations/email-mock/`): `EmailAdapter` port
  (`send(EmailMessage) → { accepted, messageId, reason }`) and
  `MockEmailAdapter`: no network, deterministic `mock-000001…` ids, in-memory
  capture (last 500), `+bounce@` → `mailbox_unavailable`, `+defer@` →
  `provider_unavailable`; logs carry reference, recipient domain and id only.
- Templates (`modules/notifications/templates/`): typed variables, subject +
  text + escaped HTML, versioned keys (`organization_invitation.v1`,
  `password_changed.v1`, `test_run_assignment.v1`, `defect_assignment.v1`,
  `defect_status_changed.v1`). Password **reset** was not added: the product
  has no reset flow, so the security mail is "your password was changed".
- Pipeline (`NotificationsService`): event → recipients (assignee, or
  reporter+assignee minus the actor for defect status, only for `resolved`,
  `closed`, `rejected`, `reopened`) → category + preference decision →
  template → `pending` row (dedupe by `dedupeKey`, so a re-assignment of the
  same cases or a repeated event produces no second attempt) → adapter →
  `sent`/`failed`/`skipped` with reason. Runs inside the event's organization
  context, not the request's. Security mail bypasses optional preferences;
  self-assignment and unassignment send nothing.
- Endpoints: `GET/PATCH /notifications/preferences` (audited),
  `GET /notifications/provider`, `GET /notifications?scope=mine|organization`
  (organization scope: owner/admin), `GET /notifications/outbox` (owner/admin,
  mock only, token-bearing query strings redacted to `?[redacted]`).
- Web: preferences on `/profile`; `/notifications` with the ledger (mine /
  organization), filters, provider banner and a clearly labelled mock outbox.
- Config: `EMAIL_PROVIDER=mock`, `EMAIL_FROM`.
- Tests: 14 integration (`test/notifications.int-spec.ts`), 11 unit
  (templates, mock adapter), 1 E2E (`notifications.e2e.spec.ts`), plus a
  regression for the MVP bug found on the way (`PATCH /defects/:id` with
  `assigneeId` returned 500 because a relation write was passed to
  `updateMany`; fixed in `defects.service.ts`).

Debt closed: none of 4, 10, 12 fully. 4 becomes "mock only" (entry 32); 10
stays because with a mock provider the token in the response is still the only
way to hand over the invitation; 12 needs the job runner. Debt recorded: 32.

## S2-F7 — File & Evidence Uploads

Real evidence upload: images, logs, txt, json, pdf and comparable files.
Binaries never go into PostgreSQL.

```text
API → StorageProvider → object storage
```

`LocalStorageProvider` in development; the architecture must allow an
S3-compatible provider later without touching call sites. Metadata stays in
`AttachmentMetadata`.

Includes size limits, an allow list of MIME types validated from content and not
from the file name, safe generated names, authorization per
organization/project, time-limited URLs or an equally safe download path,
controlled deletion, and audit. Closes debt entry 2.

### Delivery (S2-F7)

Evidence is real: bytes live on disk under a generated key, metadata lives in
PostgreSQL, and the business logic only knows a `StorageProvider` port.

```text
web (FormData) → POST /attachments → AttachmentsService → STORAGE_PROVIDER
                                                          ├─ LocalStorageProvider   (STORAGE_PROVIDER=local)
                                                          └─ MemoryStorageProvider  (STORAGE_PROVIDER=memory, tests)
                                     └─ AttachmentMetadata (PostgreSQL, metadata only)
```

- Model (migration `20260927100000_attachments_storage`): `AttachmentMetadata`
  gains `projectId`, required `checksum` (SHA-256), `storageProvider` and a
  unique `storageKey`; `deletedAt` is the soft delete. The MVP scaffold table
  was never written to, so the migration empties it before tightening the
  columns. Attachable targets: `test_result`, `defect`, `test_run`,
  `test_case` (`LinkableEntity`, no new enum).
- Storage (`apps/api/src/storage/`): `StorageProvider` port — `put`, `get`,
  `head`, `delete` over a key and a `Readable`; no paths, buckets, ACLs or
  URLs. `LocalStorageProvider` writes under `STORAGE_LOCAL_ROOT` (default
  `./var/storage`, git-ignored) with `wx` (keys are single-use), checks the
  resolved path stays inside the root, removes partial files on failure and
  deletes idempotently. `MemoryStorageProvider` keeps a `Map` and can fail the
  next operation on demand (`failNext`) for tests. `StorageModule` picks one
  from `STORAGE_PROVIDER`; `AttachmentsService` injects the token only.
- Keys: `org/<orgId>/project/<projectId>/<entityType>/<uuid>.<ext>`. The
  user's file name is sanitized for display and never used in the path.
- Validation (`file-inspection.ts`): extension **and** MIME must both be in the
  shared allow-list (`png jpg jpeg gif webp txt log json pdf`); the stream is
  hashed and counted while it is written; binary types must start with their
  magic bytes (PNG, JPEG, GIF, RIFF+WEBP, `%PDF`), text types must not contain
  NUL in the first 8 KiB. `@fastify/multipart` truncates at
  `UPLOAD_MAX_SIZE_BYTES` and the service answers `FILE_TOO_LARGE` (413);
  a rejected object is deleted from storage before the error is returned.
- Endpoints (`modules/attachments/`, project-scoped): `GET /attachments/limits`,
  `POST /attachments?entityType&entityId` (multipart, one `file` part),
  `GET /attachments?entityType&entityId`, `GET /attachments/:id`,
  `GET /attachments/:id/content?disposition=inline|attachment`,
  `DELETE /attachments/:id`. Download streams through the API with the session
  token — no public or pre-signed URL exists yet — and sets `nosniff`,
  `private, no-store` and a safe `Content-Disposition`; `inline` is honoured
  only for images and PDF, text is always `attachment`.
- Authorization: target resolved through the tenant-aware repository, then
  `ProjectAccessService.assertRouteAccess(projectId)` before any storage call.
  Any project member with a contributor role uploads; members read; the
  uploader deletes their own evidence; owner/admin/project manager/QA lead
  delete anyone's; viewers neither upload nor delete. Cross-tenant ids are 404
  or 403, never a file.
- Deletion: physical delete first, then `deletedAt`; a storage failure leaves
  the row active and retryable. Upload and delete are audited with name, size,
  type and checksum — never the content or the storage path.
- Errors: `UNSUPPORTED_FILE_TYPE` (415), `FILE_TOO_LARGE` (413),
  `STORAGE_ERROR` (503).
- Config: `STORAGE_PROVIDER=local|memory`, `STORAGE_LOCAL_ROOT=./var/storage`,
  `UPLOAD_MAX_SIZE_BYTES=10485760` (10 MiB; a development limit, not a
  commercial quota). Integration tests run with 64 KiB so the limit is
  exercised with a small file.
- Web: `AttachmentsPanel` (choose → upload with client-side pre-check of
  extension and size → list with name/type/size/uploader → Preview (images,
  blob URL) / Open (PDF, sandboxed iframe) / Download / Delete, loading and
  error states with the API's code turned into a sentence). Mounted on the run
  header (`test_run`), under the latest result of each case (`test_result`)
  and per row on Defects (`defect`). `apiFetch` accepts `FormData` and
  `apiFetchBlob` downloads bytes with the same auth/refresh path.
- Tests: 25 integration (`test/attachments.int-spec.ts`), 21 unit
  (`file-inspection.test.ts`, `storage-provider.test.ts` — the same contract
  suite runs against both providers), 1 E2E (`attachments.e2e.spec.ts`:
  fail → attach png + log → refuse `.exe` and 11 MiB → preview → download
  and compare bytes → delete → survives reload).

Debt closed: 2. Debt recorded: 33 (local disk, no S3 yet, no signed URLs, no
quotas, no virus scan, no orphan sweeper).

## S2-F8 — Granular Permissions

Evaluate permissions by organization, project, module and action:

```text
requirements.read   requirements.write
testcases.read      testcases.write
testruns.execute    defects.manage
integrations.manage members.manage
```

Predefined roles stay; configurable permissions become possible for future
plans.

**This is the riskiest phase of S2, and not because of the matrix.** Today the
project-scoped guard fails open and the decision lives in the services (debt
23), and `ProjectMember` restricts what you can _do_, not what you can _see_
(debt 22). A permission matrix must be built **on top of** that guard, replacing
the scattered decisions, or the product ends up with two authorization systems
disagreeing. Both debt entries are paid here or the phase does not close.

### Delivery (S2-F8)

Roles stay; they become **presets** of a permission catalogue, and a project can
add or remove single permissions per member. The organization is still governed
by roles alone (decision taken at the start of the phase).

```text
Organization role → ProjectMember.role (optional) → ROLE_PERMISSIONS[role]
                  → + project grants − project revokes → effective permissions
organization_owner → the whole catalogue, never narrowed
```

- Catalogue (`packages/shared/src/permissions/permission.contracts.ts`): 25
  `<module>.<action>` permissions in 11 modules. Renames against the original
  request: `test_design.*` for `testcases.*`, `project.manage` for
  `project.settings.manage`; added `requirements.manage` and
  `test_design.manage` because the routes already separated "edit" from
  "change status / delete". `ROLE_PERMISSIONS` is derived from the previous
  `@Roles` lists, so with no overrides every user keeps exactly what they had;
  a unit test asserts the ladder is monotonic.
- Model (migration `20261004100000_project_permission_overrides`):
  `ProjectPermissionOverride` (`organizationId`, `projectId`, `userId`,
  `permission`, `effect grant|revoke`, `grantedById`), unique per
  `(projectId, userId, permission)`, RLS like every tenant table. No backfill:
  no rows means the old behaviour.
- Enforcement: `@RequirePermission(...)` next to `@Roles(...)` (both read by
  the same guard, both re-applied by `ProjectAccessService.assertRouteAccess`).
  Project-scoped controllers moved to permissions; organization routes
  (create project, invitations, members, audit log) stay on `@Roles`.
- Rules (`ProjectPermissionsService`): no self-edit; owners untouchable; nobody
  edits a member more powerful than themselves; a grant must be a permission
  the actor effectively holds **in the same project**; archived projects are
  read-only; every change audited.
- Endpoints: `GET /permissions/catalog`, `GET /projects/:id/permissions/me`,
  `GET /projects/:id/permissions/members/:userId`,
  `GET /projects/:id/permissions/overrides` (`members.read`) and
  `PUT /projects/:id/permissions/members/:userId` (`members.manage`).
- Web: Project access → "Show" per member opens a matrix grouped by module with
  `Allowed / Not allowed`, the source (`ownership | role | override`) and a
  `Role default / Grant / Revoke` choice; `Grant` is disabled for what the actor
  does not hold.
- Found while running the E2E as the runtime role: creating an organization and
  accepting an invitation wrote their audit row with no tenant in context, which
  RLS rejects (500 under `qaflow_app`, invisible under the owner connection the
  integration suites use). Both now announce the organization
  (`runForOrganization`); `test/rls-runtime.int-spec.ts` boots the API as
  `qaflow_app` to keep it that way. The web also selected `undefined` after
  accepting an invitation (wrong response type); fixed.

Debt 22 (reading is not restricted per project) and 23 (the guard pre-filters
and the service decides) **stay open**: the phase kept the approved scope, and
both are now described in permission terms in `technical-debt.md`. Debt 34
records what S2-F8 itself leaves.

## S2-F9 — Project KPI & Analytics Dashboard

Quality dashboards at project and organization level.

### Project dashboard

Minimum: pass rate, failed rate, blocked rate, skipped/untested, execution
progress, cases executed vs pending, `Requirement → TestCase` coverage,
requirements with no coverage, open defects, defects by severity, defects by
priority, open vs closed defects, defects per execution, and the historical
evolution of pass rate, coverage and defects.

Prepared for, once there is enough data: mean time to resolve a defect, trends
by release/sprint, and period-over-period comparison.

### Organization dashboard

A consolidated view across the organization's projects: overall QA health,
projects with the most failures, projects with the least coverage, open critical
defects, global trends, recent activity.

### Architecture

KPIs are computed in the backend. The frontend must never download bulk
`TestResult`/`Defect` rows to compute a metric — that is the current dashboard's
debt entry 16, and repeating it at this scale makes the page unusable on real
data.

Aggregated contracts, names adaptable to existing conventions:

```text
GET /api/v1/projects/:projectId/dashboard/summary
GET /api/v1/projects/:projectId/dashboard/test-results
GET /api/v1/projects/:projectId/dashboard/coverage
GET /api/v1/projects/:projectId/dashboard/defects
GET /api/v1/projects/:projectId/dashboard/trends
GET /api/v1/dashboard/organization
```

Each response carries the period it covers and the moment it was computed. A KPI
without its window is not a number, it is an opinion.

### Visualization

Lines for trends, bars for comparisons, donut/pie only for simple
distributions, prominent KPI indicators, detail tables where they help.
Responsive and accessible: every chart needs a text or table equivalent, colour
is never the only carrier of meaning, and severity keeps its shape as well as
its hue.

### Future integrations

The contracts are designed so internal data can later be combined with Jira,
TestRail, GitHub Actions and Playwright/automation. The dashboard is coupled to
**none** of them: an aggregate is fed by sources, and a missing source degrades
one series instead of breaking the page.

### Rules

Respect `organizationId` and project permissions; never mix tenant data; no N+1
queries — aggregate in SQL; add indexes or aggregate queries where measurement
shows they are needed; isolation tests and metric-calculation tests; and every
KPI formula documented, including what it does with a case that was never
executed, which is the number people disagree about.

### Delivered

Six endpoints, all behind `analytics.read`; the five project routes are
`@ProjectScoped` and resolved by `ProjectAccessService.assertRouteAccess`. The
query string is `from`, `to` (ISO-8601, `[from, to)`) and `bucket`
(`day|week|month`); defaults are the last 30 days and a bucket chosen from the
window length (≤ 31 days → day, ≤ 186 → week, otherwise month); the window is at
most 366 days and `from < to`. Buckets are UTC, weeks start on Monday. Every
response carries `period { from, to, bucket }` and `computedAt`.

| KPI                        | Formula                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| planned                    | run cases of the runs in scope                                                                                            |
| executed / pending         | `planned − untested` / `untested`                                                                                         |
| pass, failed, blocked rate | count / `verdicts`, where `verdicts = passed + failed + blocked`                                                          |
| skipped, untested rate     | count / `planned`                                                                                                         |
| execution progress         | `executed / planned`                                                                                                      |
| coverage                   | active (not deleted, not `obsolete`) requirements with ≥ 1 `requirement → test_case` link / active requirements           |
| open defects               | not deleted, status not in `closed`, `rejected`                                                                           |
| open critical              | open with severity `blocker` or `critical`                                                                                |
| defects per executed case  | defects whose `testRunId` is a run in scope / executed cases                                                              |
| mean time to resolve       | mean of `COALESCE(resolvedAt, closedAt) − createdAt`, in hours, over defects resolved in the window, with its sample size |
| period comparison          | same KPI over the previous window of equal length; `delta` in points                                                      |

A **run in scope** is a non-deleted, non-aborted run that was alive during the
window: created before `to`, and not completed before `from`. The current
distribution uses `TestRunCase.latestStatus` (one row per case, the last
result wins); trends count **every** result recorded in each bucket. Every rate
with a zero denominator is `null` (rendered as "—"), never 0 — except progress of
a non-empty plan with nothing executed, which is a real 0.

The organization dashboard aggregates only the active projects in which the
caller holds `analytics.read` (a project revoke removes the project from every
total, ranking, trend and activity item), with health totals, the five projects
with most failed cases, the five with the lowest coverage, open critical
defects, global trends and the last 15 activity items (results, defects, runs).

Every figure comes from grouped SQL (`COUNT … GROUP BY`, `EXISTS` for coverage)
inside a transaction that sets `app.current_organization`, with every table
filtered by `organizationId` and an explicit, already-authorized
`projectId = ANY(...)` list; no request transfers `TestResult` or `Defect`
rows, and the bounded lists (20 runs, 50 uncovered requirements, 15 activity
items) are the only row-level data. The web renders the KPIs, an execution
distribution with its table, bar lists with printed values, SVG trend lines
with distinct dash patterns and a data table each, and a window selector. The
MVP endpoint `GET /dashboard` stays for compatibility; its coverage count is
now one `EXISTS` statement instead of loading requirement ids. Debt: entry 35.

## S2-F10 — Production Readiness

Per-environment configuration, secrets, backups, health/readiness checks,
observability, structured logs, error handling, safe migrations, distributable
rate limiting, storage policy, security, CORS, CSP, deployment documentation and
basic disaster recovery.

No real deployment without explicit authorization. Distributable rate limiting
(debt 1) is the only item pushing towards Redis; the alternative — per-instance
limits plus an edge limit at the provider — is presented first, and Redis is
introduced only with approval.

**Delivered.** Decisions approved before implementation: rate limiting **A**
(no Redis: per-instance global limit, a stricter per-address limit on login,
register and refresh, the edge limit documented — with N replicas the
effective limit is N×) and credential store **A** (ADR 0014: external secret
manager behind a `SecretResolver` port with an environment provider; no
table, no migration; the real provider arrives with GitHub Real). No
migration, no UI change, no product behaviour change.

| Area           | What exists now                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration  | production fails closed: equal/placeholder/low-entropy JWT secrets, `STORAGE_PROVIDER=memory`, wildcard CORS, metrics without a strong token. New: `TRUST_PROXY`, `LOG_FORMAT`, `SHUTDOWN_GRACE_MS`, `AUTH_RATE_LIMIT_*`, `METRICS_*` |
| Bootstrap      | one `configureApp()` shared by `main.ts` and the integration harness (plugins, hooks, filter, prefix), so tests exercise the production pipeline                                                                                      |
| RLS role guard | `DatabaseRoleInspector` refuses to boot in production as superuser, `BYPASSRLS` or table owner                                                                                                                                        |
| Probes         | `GET /health` liveness (no DB); `GET /health/ready` DB, migrations applied, storage writable, role, draining → 200/503, no details                                                                                                    |
| Shutdown       | SIGTERM → readiness 503 → `SHUTDOWN_GRACE_MS` → close                                                                                                                                                                                 |
| Correlation    | validated `X-Request-Id`, one id across header, error, logs and audit; proxy-aware client address shared by rate limiter and audit                                                                                                    |
| Logs           | JSON lines in production, one `request completed` line per request (method, route template, status, duration), credential keys redacted                                                                                               |
| Metrics        | optional `GET /metrics` (Prometheus text, bearer token), labels method/route template/status only                                                                                                                                     |
| Errors         | 429 `RATE_LIMITED` + `Retry-After`; Fastify 4xx (413, 415, 400) keep their status; generic 5xx                                                                                                                                        |
| Headers        | API CSP `default-src 'none'`; web CSP and security headers in nginx, mirrored in `vite preview` for E2E; nginx `client_max_body_size` matches uploads                                                                                 |
| Storage        | `api-storage` volume in compose, writable directory in the image, readiness probe                                                                                                                                                     |
| Migrations     | `npm run db:migrations:check` in CI: destructive and RLS-weakening statements need an explicit marker                                                                                                                                 |
| DR             | `scripts/db-backup.sh`, `scripts/restore-drill.sh` (checksum, migrations, RLS identical to source, runtime grants), RPO/RTO, retention and restore runbook in `deployment.md`                                                         |

Course: chapter 41. Debt: entry 36 (and updates to 1 and 33).

## S2-F11 — Billing & Subscriptions

Plans, subscriptions, usage limits, trial, subscription states, billing
customer, invoices, webhooks, upgrades/downgrades, cancellation — behind a
`BillingProvider` abstraction.

`OrganizationPlan` exists today as an enum; whether it becomes a table is the
first decision of the phase. Stripe may be evaluated when the phase starts, and
alternatives are presented before it is assumed.

## Related

- [`commercial-roadmap.md`](commercial-roadmap.md) — why this order sells
- [`integrations-roadmap.md`](integrations-roadmap.md) — the shape of each integration
- [`technical-debt.md`](technical-debt.md) — every entry with its trigger
- [`permissions-matrix.md`](permissions-matrix.md) — the roles S2-F8 extends
