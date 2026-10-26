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

## S4-F2 — Backlog

ADR 0024, debt 46.

**Status: implemented.**

- Migration `20261220100000_work_item_backlog_rank`: `work_items.rank` (gapped,
  backfilled by creation order) and an index on `(organizationId, projectId,
rank)`.
- `GET /backlog` (ordered, open items by default, grouping by epic or feature,
  release and personal `assigneeId=me` views, filters, search, estimate
  totals), `POST /work-items/:id/move` (before/after an item) and
  `POST /work-items/bulk` (status, priority, assignee, release, estimate,
  labels; up to 100 items, all or nothing).
- Concurrency: project backlog advisory lock for creation and moves, rows
  locked in id order for bulk edits; every move and bulk change audited.
- Web: Backlog page with drag and drop and arrow buttons, filters, grouping,
  totals, selection and a bulk action bar.
- Tests: `backlog.int-spec.ts`, `BacklogPage.test.tsx`, `backlog.e2e.spec.ts`.

## S4-F3 — Hierarchy

No migration and no new ADR (it builds on ADR 0023); debt 47.

**Status: implemented.**

- `GET /work-items/tree`: the project hierarchy in backlog order, with
  rollups per node (descendant counts by status, estimate sum, unestimated,
  progress without cancelled items) and totals; filters (type, status,
  assignee incl. `me`/`none`, search) keep ancestors of matches for context;
  `rootId` for a subtree.
- `POST /work-items/:id/reparent` (`parentId` or `null`, optional `version`):
  same locks and checks as editing `parentId` — ranked types (no cycles),
  explicit maximum depth of 4, composite FKs, foreign parents answered like
  missing ones, audited as "Reparented … under …".
- `GET /work-items/:id` adds `rollup`; ancestors are the breadcrumb.
- Web: Hierarchy page with an expandable/collapsible tree, expand/collapse
  all, filters and search, rollups and a "Move under" control per node; the
  detail page shows the children rollup.
- Tests: `hierarchy.int-spec.ts`, `HierarchyPage.test.tsx`,
  `hierarchy.e2e.spec.ts`, rollup unit tests in the shared contracts.

## S4-F4 — Requirement ↔ Work Item

One migration (`requirement_work_items` + the `(id, projectId)` key on
requirements); no new ADR; debt 48.

**Status: implemented.**

- A work item `implements` one or more requirements and a requirement is
  implemented by one or more work items. Both composite foreign keys carry
  `projectId`, so the database refuses a link across projects or tenants;
  RLS by organization.
- `GET|POST /requirements/:id/work-items`, `DELETE
/requirements/:id/work-items/:workItemId` and the mirror routes under
  `/work-items/:id/requirements`. Linking is idempotent (`created: false`
  for an existing link), unlinking a missing link answers 204 and records
  nothing; link and unlink are audited.
- Both ends are share-locked (requirement first, then work item) and must be
  live: a concurrent soft delete either waits for the link or makes it 404.
  Links to deleted ends are hidden everywhere.
- Writing needs `work_items.write` plus `requirements.read` on the project;
  reading needs read on both sides. Foreign, hidden or deleted ids answer
  like missing ones.
- Implementation state from the linked items' statuses
  (`computeImplementation`): not implemented (nothing done), partially
  implemented, implemented (every non-cancelled item done). `RequirementView`
  carries `implementation`; `GET /requirements?implementation=…` filters.
- Traceability: matrix rows add `workItems` and `implementation` (summary
  `implemented`), and the release traceability lists the implementing items
  planned in that release, so the chain reads Requirement → Work item → Test
  case → Run → Result → Defect → Release.
- Web: Requirement detail page (implemented-by list, link/unlink, badge),
  "Implements" section in the work item detail, implementation column and
  filter on Requirements, work items column in Traceability.
- Tests: `requirement-links.int-spec.ts`, `requirement-links.contracts.test.ts`,
  `ImplementationBadge.test.tsx`, `requirement-links.e2e.spec.ts`.

## S4-F5 — Sprint

One migration (`sprints`, `work_items.sprintId`); no new ADR; debt 49.

**Status: implemented.**

- `Sprint` belongs to a project: name, goal, start/end date (`DATE`, start
  ≤ end checked by the API and a `CHECK`), capacity (points), status
  `planned → active → completed`, or `planned|active → cancelled`.
  Completed and cancelled sprints are frozen: no edit, no item in or out, no
  transition (409). Sprints are never deleted.
- At most one active sprint per project: `start` takes a per-project advisory
  lock and checks, and a partial unique index (`WHERE status = 'active'`) is
  the database backstop (a race answers 409).
- `work_items.sprintId` has a composite foreign key `(sprintId, projectId)`
  → `sprints(id, projectId)`, so an item can only be planned into a sprint of
  its own project and tenant.
- `POST /sprints/:id/items` plans items (from the backlog or another open
  sprint, never done/cancelled ones) and `POST /sprints/:id/items/remove`
  sends them back to the backlog; up to 100 ids, all or nothing, foreign or
  missing ids answer one 404.
- `POST /sprints/:id/complete|cancel` with `carryOverTo` (`backlog` or a
  planned sprint of the same project) moves every unfinished item; done and
  cancelled items stay with the closed sprint as its history.
- Metrics (`computeSprintMetrics`): count and progress by status, scope,
  committed estimate (frozen at start), completed estimate (frozen at close),
  unestimated items, capacity and load (scope / capacity). Velocity is the
  average completed estimate of the last 3 completed sprints
  (`computeVelocity`), returned with `GET /sprints`.
- Lock order: activation advisory lock → sprint rows (id order, `FOR UPDATE`
  for transitions, `FOR SHARE` for planning) → work item rows (id order).
  Edits carry an optional `version` (409 when stale).
- `sprintId` filter (`<id>` or `none`) on `GET /work-items` and `GET /backlog`.
- Permissions: read `work_items.read`; plan items `work_items.write`; create,
  edit, start, complete, cancel `work_items.manage`. Every change is audited.
- Web: Sprints page (create, list, status filter, velocity), Sprint detail
  (metrics, progress by status, edit, start/complete/cancel with carry-over
  target, sprint backlog, plan from the backlog), Sprint filter on Backlog.
- Tests: `sprints.int-spec.ts`, `sprint.contracts.test.ts`,
  `sprints.e2e.spec.ts`.

## Next candidates

- S4-F6 Scrum Board and S4-F7 Kanban over sprints and work items.
- Links between work items and test cases or defects.
- Development and CI views on top of the existing GitHub mock and ingestion.

## Related

- [`stage-3-roadmap.md`](stage-3-roadmap.md) — the stage this one builds on
- [`adr/0023-work-items-ranked-hierarchy.md`](adr/0023-work-items-ranked-hierarchy.md)
- [`adr/0024-backlog-gapped-ranks.md`](adr/0024-backlog-gapped-ranks.md)
