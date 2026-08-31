# Stage 2 (S2) — Integrations and commercial readiness

This is the plan for the stage **after** the MVP. Nothing here is implemented:
the document exists so that each phase starts from a written contract instead of
a conversation.

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

| Phase | Name | Theme |
| --- | --- | --- |
| S2-F1 | Integration Settings | Integrations |
| S2-F2 | Jira Mock | Integrations |
| S2-F3 | TestRail Mock | Integrations |
| S2-F4 | GitHub Real | Integrations |
| S2-F5 | External Traceability | Traceability |
| S2-F6 | Email Notifications | Notifications |
| S2-F7 | File & Evidence Uploads | Evidence |
| S2-F8 | Granular Permissions | Authorization |
| S2-F9 | Project KPI & Analytics Dashboard | Analytics |
| S2-F10 | Production Readiness | Operations |
| S2-F11 | Billing & Subscriptions | Commercial |

KPI & Analytics was added after the stage was approved and is inserted **before**
Production Readiness and Billing, which shifts those two phases to F10 and F11.
No phase was removed or replaced.

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

## S2-F2 — Jira Mock

A simulated Jira provider behind the same port as the real one: projects,
issues, stories/tasks, bugs, priorities, statuses, assignees, external IDs,
simulated create and update, and simulated synchronization with `Requirement`
and `Defect` through `ExternalReference`.

Rules: no real network call; the mock is deterministic and seedable so tests can
assert against it; latency and failure injection so the UI is built against a
provider that fails, which is the state a real one spends part of its time in.

## S2-F3 — TestRail Mock

Same shape, TestRail vocabulary: projects, suites, sections, test cases, runs,
results, external IDs, simulated import and synchronization with the internal
entities. No corporate account, no real credential.

Import is where the mapping decisions live: partial failure must be reported per
row, and a dry run must exist before anything is written.

## S2-F4 — GitHub Real

The first real integration, with a personal account only.

Scope: connect an account, choose authorized repositories, read workflows and
workflow runs, associate automated results with `TestCase`/`TestRun`/
`TestResult`, and leave the seam for Playwright report ingestion.

This is the only phase that touches security at the root: **the MVP has no
credential store.** `secretRef` points at a secret manager that does not exist
yet. This phase must deliver encryption with a key from the environment, token
refresh, revocation on disconnect, and a token that is never logged, never
audited and never returned. Least privilege: read-only scopes for the read-only
features.

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

## S2-F6 — Email Notifications

An `EmailProvider` abstraction with a sandbox/mock provider in development and
no irreversible dependency on a commercial vendor.

Initial cases: organization invitation, password recovery/change, test-run
assignment, defect assignment, and configurable important events.

This phase closes debt entries 4 and 10 (the invitation token is returned in the
API response today) and 12 (lazy invitation expiry). Sending must not happen in
the request path once it can fail, which is where the job runner (debt 3) gets
decided.

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
23), and `ProjectMember` restricts what you can *do*, not what you can *see*
(debt 22). A permission matrix must be built **on top of** that guard, replacing
the scattered decisions, or the product ends up with two authorization systems
disagreeing. Both debt entries are paid here or the phase does not close.

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

## S2-F10 — Production Readiness

Per-environment configuration, secrets, backups, health/readiness checks,
observability, structured logs, error handling, safe migrations, distributable
rate limiting, storage policy, security, CORS, CSP, deployment documentation and
basic disaster recovery.

No real deployment without explicit authorization. Distributable rate limiting
(debt 1) is the only item pushing towards Redis; the alternative — per-instance
limits plus an edge limit at the provider — is presented first, and Redis is
introduced only with approval.

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
