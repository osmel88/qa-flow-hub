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
