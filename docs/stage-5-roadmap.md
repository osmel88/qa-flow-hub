# Stage 5 (S5) — Development & CI

Stage 4 closed Planning & Work Management (work items, backlog, hierarchy,
requirement links, sprints, Scrum and Kanban boards). Stage 5 connects work
items with development activity, still without real providers.

```text
Requirements → Planning → Work Items/Backlog → Sprints → Development → CI → QA → Defects → Releases → Analytics
```

Hard constraints, unchanged:

- No real external provider (GitHub, GitLab, Azure DevOps, Billing,
  SSO/SAML/SCIM…); everything runs local/mock.
- Debt 39 (project visibility in RLS) stays out of scope.
- Every phase closes with lint, typecheck, unit, integration, E2E, build and
  `db:migrations:check`, then commit and push.

## S5-F1 — Development Links

- New tables (1 migration): `development_artifacts` (branch, commit, pull
  request, build, deployment) and `work_item_development_links`
  (many-to-many). Both link foreign keys carry `projectId`, so the database
  refuses cross-project or cross-tenant links; RLS on both; artifacts cannot be
  deleted by the app role (soft delete).
- Provider-neutral: `provider` (`local`, `github`, `gitlab`, `azure_devops`,
  `bitbucket`; only `local` is used), optional `externalId`, `url` (http(s)
  only) and `title`; per kind `branchName`, `commitSha` (stored lowercase),
  `prNumber`, `identifier` (build/deployment) and `environment`
  (deployment); `status` validated per kind (CHECK + Zod); `occurredAt`,
  timestamps and `version`.
- No duplicates: one live artifact per (project, provider, kind, natural key)
  and per (project, provider, kind, externalId), as partial unique indexes;
  a duplicate answers 409 `DUPLICATE_RESOURCE`, also under concurrent
  creation. A deleted artifact can be recorded again.
- API: `/development-artifacts` (create with optional `workItemIds`, list
  with `kind`/`provider`/`status`/`workItemId` (`none`)/`search`, detail,
  `PATCH` with `version`, soft `DELETE`), `/development-artifacts/:id/work-items`
  and `/work-items/:id/development` to link and unlink from either side. Link
  is idempotent (`created: false`), unlink answers 204 even when nothing was
  linked; only real changes are audited.
- Concurrency: artifact locked first (`FOR SHARE` for links, `FOR UPDATE` for
  edits/deletes), then the work item(s) `FOR SHARE`; links use
  `ON CONFLICT DO NOTHING`.
- Isolation: ids of other projects or tenants, or of hidden projects, answer
  404 like missing ones. Deleted artifacts and deleted work items disappear
  from every view; their rows and links stay as history.
- Permissions: `work_items.read` to read, `work_items.write` to record, edit,
  link and unlink, `work_items.manage` to delete an artifact.
- Adapters: `DevelopmentActivitySource` (port only) is what a future
  GitHub/GitLab/Azure DevOps adapter implements; see ADR 0025.
- Web: Development page (consolidated activity with filters and a form to
  record activity) and a Development section in the work item detail with
  link/unlink and links both ways.
- Tests: `development.int-spec.ts`, `development.contracts.test.ts`,
  `DevelopmentPage.test.tsx`, `development.e2e.spec.ts`.

## S5-F2 — Development Status

- Each work item has a development status derived on read from its live
  linked artifacts (`computeDevelopmentStatus()` in the shared package),
  never stored: `no_development`, `branch_created`, `commits`, `pr_open`,
  `pr_approved`, `merged`, `build_running`, `build_passed`, `build_failed`,
  `deployed`, listed from lowest to highest precedence.
- Rules: a succeeded deployment wins; otherwise the latest build that ran
  (by `occurredAt`, then creation, ties by id) decides failed/passed/running,
  so a failed build shows over commits and pull requests; then a merged,
  approved, or open/draft pull request; then commits; then a branch not
  deleted. Closed PRs, cancelled builds and failed/pending deployments never
  raise it. Deleted artifacts and deleted links do not count. The result is
  the same whatever the order of the links, with the artifacts that justify
  it (`evidence`).
- 1 migration: pull requests may now be `approved` (the status CHECK is
  replaced with the same rules plus `approved`).
- Every change of a derived status caused by a link, unlink, artifact edit,
  delete or creation is audited on the work item (`Development status of
KEY: from → to`). Those writes lock the affected work items `FOR UPDATE`
  (after the artifact), so concurrent changes chain consistently.
- API: `summary` (status, evidence, counts, last activity) in
  `GET /work-items/:id/development`; `developmentStatus` filter on
  `/work-items`, `/backlog`, `/work-items/tree`, `/sprints/board` and
  `/kanban`; `developmentStatuses` maps in backlog and tree views and
  `developmentStatus` on board cards; `GET /development-artifacts/summary`
  (work items per status, artifacts per kind).
- Web: status and evidence links in the work item detail, badges and a
  "Development filter" in Backlog, Hierarchy, Board and Kanban, and a summary
  on the Development page.
- Tests: `development-status.int-spec.ts`, `development-status.test.ts`,
  extended `development.e2e.spec.ts`.

## S5-F3 — Code Review

- Internal, provider-neutral code reviews (`code_reviews`, 1 migration with
  5 tables: reviews, reviewers, work item links, append-only events and the
  project approval rule). A review belongs to a project and optionally to a
  local pull request artifact and to work items; composite foreign keys with
  `projectId` refuse anything across projects or tenants, RLS isolates
  tenants, reviews are soft-deleted and `provider`/`externalId` are ready for
  a future GitHub/GitLab adapter.
- Statuses `pending`, `in_review`, `changes_requested`, `approved`,
  `dismissed`. Each reviewer holds one decision; the review status is
  recomputed from the decisions (`computeCodeReviewStatus()`) under the
  review row lock, so concurrent approve/request changes/dismiss apply one at
  a time. `dismissed` closes the review.
- Rules: the author can never be a reviewer or decide; only assigned
  reviewers with `code_reviews.review` decide; approving twice answers 409;
  reviewers must be active members who can review in the project. Required
  approvals per review, or the project rule (`PUT /code-reviews/settings`,
  default 1).
- Merge readiness is derived (`computeMergeReadiness()`): not dismissed, no
  change request, enough approvals from reviewers who can still review, and
  the pull request (if any) open or approved; blockers are listed.
- Development status: a live, not dismissed review of a work item (directly
  or through its pull request) counts as a pull request signal, `approved`
  as `pr_approved`; reviews are not counted as artifacts.
- History: every action writes a `code_review_events` row and an audit
  entry; development status changes it causes are audited on the work item.
- Web: Code reviews page (filters by status, reviewer, author; open form),
  review detail (decide, reviewers, comments, work items, history, dismiss)
  and a Code reviews section in the work item detail.
- Tests: `code-reviews.int-spec.ts`, `code-review.contracts.test.ts`,
  `code-reviews.e2e.spec.ts`.

## Next candidates

- CI views on top of builds and the existing ingestion of test results.
- Links between work items and test cases or defects.

## Related

- [`stage-4-roadmap.md`](stage-4-roadmap.md)
- [`adr/0025-provider-neutral-development-artifacts.md`](adr/0025-provider-neutral-development-artifacts.md)
