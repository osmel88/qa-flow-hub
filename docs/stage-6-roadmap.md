# Stage 6 (S6) — Environments & Release Management

Stage 5 closed Development Tracking (development links and status, code
reviews, builds, deployments). Stage 6 manages where software runs and how
releases get there, still without real providers.

```text
Requirements → Planning → Work Items/Backlog → Sprints → Development → CI → QA → Defects → Releases → Analytics
```

Hard constraints, unchanged: no real provider (GitHub, GitLab, Azure DevOps,
Billing, SSO/SAML/SCIM); debt 39 stays out of scope.

## S6-F1 — Environment

- The minimal `environments` table of S5-F5 is migrated in place (1
  migration): `description`, `status` (`active`, `inactive`, `archived`,
  with `archivedAt`), `protected`, `position` (0–999), `url` (http/https),
  non-sensitive `metadata` and `version`. Kinds become `development`, `qa`,
  `staging`, `production`, `custom` (backfill `testing` → `qa`, `other` →
  `custom`); production is protected by default and the order follows
  creation. Existing deployments keep their environment.
- Names are unique per project (case-insensitive) among live environments,
  archived ones included; concurrent creates answer one 201 and 409s.
- `GET /environments` (filters status, kind, protected, health, search;
  archived hidden unless `includeArchived=true` or `status=archived`),
  `GET /environments/:id`, `POST`, `PATCH` (optional `version`),
  `POST /:id/archive`, `POST /:id/restore`, `DELETE /:id`. Reading needs
  `work_items.read`, the rest `work_items.manage`.
- An environment with deployment history cannot be deleted (409): archive
  it. Archiving waits for deployments being recorded (row lock) and refuses
  while one is still pending or deploying.
- Archived or inactive environments take no new deployment or rollback
  (409); deployments in flight can still finish.
- Protected environments need `work_items.manage` to report, move, edit or
  roll back a deployment, also through the generic artifact `PATCH`.
- Each view carries the derived health (`healthy`, `deploying`, `failing`,
  `idle`, `inactive`, `archived`), the deployment count, what runs there
  (deployment, build, commit, release) and the last deployment.
- Web: Environments page (filters, creation) and environment detail (edit,
  archive/restore/delete, recent deployments).
- Tests: `environments.int-spec.ts` (including the migration backfill),
  `environment.contracts.test.ts`, `environments.e2e.spec.ts`.

## S6-F2 — Release Pipeline

- `GET /releases/:id/pipeline` (filters `environmentId`, `status`) derives the
  pipeline of a release on every read; nothing is stored and no migration
  is needed. Needs `releases.read` and `work_items.read`.
- Stages are the active and inactive environments of the release's project,
  in environment order. Archived environments where the release ran are
  returned as `history`, outside the active flow.
- Stage rules (`computePipelineStages()`, shared): the newest non-cancelled
  deployment of the release decides — pending/deploying → `deploying`,
  failed → `failed`, succeeded → `deployed`; a rolled back release counts as
  not deployed (`rolledBack`). Otherwise known blockers give `blocked`
  (archived release, inactive environment, open blocker/critical defects
  of the release's runs, previous stage failed); `ready` needs a passed
  build of the release and the previous stage deployed; else `pending`.
- Pipeline status: failed > deploying > completed > blocked > in progress >
  not started; progress counts deployed stages over all stages.
- Each stage carries the environment (with its protected flag), the last
  deployment (build, commit, actor, dates), the deployment count, whether
  the current user may deploy there and the QA of the newest non-aborted
  run of the release whose environment matches by name.
- All reads share one REPEATABLE READ snapshot, so a pipeline read while
  deployments move is internally consistent. Being read-only, it writes no
  audit entries; the deployments it reflects are audited.
- Web: pipeline page (summary, progress, blocking defects, filters, stage
  timeline, archived history) linked from the release detail.
- Tests: `release-pipeline.int-spec.ts`, `release-pipeline.contracts.test.ts`,
  `release-pipeline.e2e.spec.ts`.

## S6-F3 — Quality Gates

- 1 migration: `quality_gates` (project, optional environment, `required`,
  `enabled`, `version`, soft delete, unique live name), `quality_gate_rules`
  (one per type with its threshold) and `quality_gate_overrides`
  (append-only: release, environment, reason of at least 10 characters,
  the gate status it overrode, author). All with RLS and composite foreign
  keys with `projectId`.
- Rules: `min_pass_rate`, `max_failed_tests`, `max_blocked_tests`,
  `min_requirement_coverage`, `max_open_critical_defects` (blocker +
  critical), `max_open_high_defects` (major), `build_must_pass`,
  `completed_test_run_required`, `code_review_approval_required`. A gate
  combines several; results are `passed`, `failed`, `pending` (missing data)
  or `not_applicable`, each with the measured value, a message and links to
  the runs, defects, build, reviews or requirements behind it.
- Results are evaluated on read (`GET /releases/:id/quality-gates`, one
  REPEATABLE READ snapshot) and never stored. Project-wide gates apply to
  every environment; environment gates only there.
- Protected environments: a deployment (or a move to `deploying`) of a
  release needs its required gates `passed`/`not_applicable` or an override
  (409 `QUALITY_GATE_FAILED` with the failing rules); without a release it is
  refused when required gates exist. Checked inside the deployment
  transaction.
- Overrides: `POST /releases/:id/quality-gates/override` needs the new
  `quality_gates.override` permission (project manager and above), refuses
  when there is nothing to override, and is audited.
- The release pipeline shows the gates of each stage and blocks protected
  stages (`quality_gates`) until gates pass or are overridden.
- API: `/quality-gates` CRUD (`releases.read` / `releases.manage`, optional
  `version`). Web: Quality gates page and a gates section with override in
  the pipeline page.
- Tests: `quality-gates.int-spec.ts`, `quality-gate.contracts.test.ts`,
  `quality-gates.e2e.spec.ts`.

## S6-F4 — Release Approval

- 1 migration: `release_approval_rules` (project, optional environment,
  type `qa` / `product` / `engineering` / `release_manager`, required count
  1–10, `allowSelfApproval`, `enabled`, `version`, soft delete, one live rule
  per type and scope) and `release_approvals` (decision history: release,
  optional environment, type, `approved` / `rejected` / `changes_requested`,
  comment, approver, revocation). The application may only insert decisions
  and set the revocation columns; a partial unique index allows one live
  decision per approver, type and scope. RLS and composite foreign keys with
  `projectId` everywhere.
- The workflow state is derived on read: per type, a live rejection beats a
  change request, which beats counting approvals against the highest
  required count; the release state is the worst of them (`rejected` >
  `changes_requested` > `pending` > `approved`, no requirement = approved).
  Environment evaluation counts release-wide decisions and that
  environment's own.
- Decisions: `POST /releases/:id/approvals` (`releases.approve`, tester and
  above; checked again in the service so a revoked permission refuses even
  with a stale screen). Reject and request changes need a comment of at least
  5 characters. The release creator cannot approve unless every applicable
  rule of that type allows it. Archived releases refuse decisions and
  revocations (409) and keep their history.
- Revocation: `POST /releases/:id/approvals/:approvalId/revoke` by the
  approver or anyone with `releases.manage`; it marks the decision, never
  deletes it. Everything is audited.
- Protected environments: a deployment (or a move to `deploying`) needs the
  applicable approvals `approved` (409 `APPROVAL_REQUIRED` with the missing
  ones), checked inside the deployment transaction after quality gates; both
  must hold. No approval override exists.
- The release pipeline shows the approval state of each stage and blocks
  protected stages (`approvals`).
- API: `/release-approval-rules` CRUD (`releases.read` / `releases.manage`),
  `GET /releases/:id/approvals?environmentId=`. Web: Approval rules page and
  an Approvals section in the pipeline page.
- Tests: `release-approvals.int-spec.ts`, `release-approval.contracts.test.ts`,
  `release-approvals.e2e.spec.ts`.
