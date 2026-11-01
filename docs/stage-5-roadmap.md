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

## Next candidates

- CI views on top of builds and the existing ingestion of test results.
- Links between work items and test cases or defects.

## Related

- [`stage-4-roadmap.md`](stage-4-roadmap.md)
- [`adr/0025-provider-neutral-development-artifacts.md`](adr/0025-provider-neutral-development-artifacts.md)
