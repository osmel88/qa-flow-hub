# Stage 4 (S4) — Software delivery lifecycle

The official scope widens: qa-flow-hub becomes a multi-tenant platform for the
software development lifecycle, from requirements and planning through
development, QA, releases and metrics. External integrations stay optional;
the product must keep working fully in local/mock mode.

Target flow:

```text
Requirements → Planning → Work Items/Backlog → Sprints → Development → CI → QA → Defects → Releases → Analytics
```

Hard constraints, unchanged from Stage 3:

- No real external provider (GitHub, Billing, SSO/SAML/SCIM, Jira…); use the
  existing ports with local/mock adapters.
- Debt 39 (project visibility in RLS) stays out of scope.
- Every phase closes with lint, typecheck, unit, integration, E2E, build and
  `db:migrations:check`, then commit and push.

## S4-F1 — Work Items Core

ADR 0023, debt 45.

**Status: implemented.**

- Migration `20261213100000_work_items`: enums `WorkItemType`,
  `WorkItemStatus`; table `work_items` (RLS by organization, no `DELETE` for
  the app role, composite FKs for parent and release, GIN index on `labels`,
  CHECKs on estimate, label count and self-parenting); column
  `projects.workItemCounter` for `PROJ-W-n` keys.
- `/work-items`: create, list (type, status, priority, assignee, reporter,
  parent, release, label, open/closed, search by title or key), detail with
  ancestors and children, patch with optional `version`, soft delete.
- Permissions `work_items.read`, `work_items.write`, `work_items.manage`.
- Ranked hierarchy (epic → feature → story/bug/improvement/spike → task),
  serialised per project with an advisory lock.
- Optional release, only while open; an item cannot leave a shipped release.
- Web: Work items list with filters and creation form, detail page to edit
  every field (parent, release, assignee) and see ancestors and children.
- Tests: `work-item.contracts.test.ts`, `work-items.int-spec.ts`,
  `WorkItemsPage.test.tsx`, `work-items.e2e.spec.ts`.

## Next candidates

- Sprints / iterations and capacity planning over work items.
- Links between work items, requirements, test cases and defects.
- Development and CI views on top of the existing GitHub mock and ingestion.

## Related

- [`stage-3-roadmap.md`](stage-3-roadmap.md) — the stage this one builds on
- [`adr/0023-work-items-ranked-hierarchy.md`](adr/0023-work-items-ranked-hierarchy.md)
