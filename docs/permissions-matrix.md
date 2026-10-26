# Permissions matrix

Six roles, which since S2-F8 are **presets of a permission catalogue**: each
role maps to a fixed set of `<module>.<action>` permissions, and a project can
grant or revoke single permissions per member (see
[Granular permissions](#granular-permissions-s2-f8) below). The reasoning is in
[`backend-course/13-authorization-and-roles.md`](backend-course/13-authorization-and-roles.md);
`@Roles` stays valid next to the new `@RequirePermission`.

Roles are scoped to an **organization**, and may be overridden **per project**.
The same person can be a `qa_lead` in one organization and a `viewer` in
another — and, inside one organization, a `qa_lead` on the mobile project and a
`viewer` on the web one.

## Roles

| Role                 | Intended for                                                 |
| -------------------- | ------------------------------------------------------------ |
| `organization_owner` | Whoever signed up. Billing and the organization's existence. |
| `organization_admin` | Day-to-day administration: members, projects, settings.      |
| `project_manager`    | Owns a project's scope: requirements, planning, releases.    |
| `qa_lead`            | Owns test design and execution planning.                     |
| `tester`             | Executes tests and reports defects.                          |
| `viewer`             | Read-only. Stakeholders, clients, auditors.                  |

## Matrix

`✓` allowed · `own` only the rows they created or are assigned · `—` denied

| Action                                     | owner | admin | proj. manager | qa_lead | tester | viewer |
| ------------------------------------------ | :---: | :---: | :-----------: | :-----: | :----: | :----: |
| **Organization**                           |       |       |               |         |        |        |
| Rename                                     |   ✓   |   —   |       —       |    —    |   —    |   —    |
| Read plan, usage and invoices (`/billing`) |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| Checkout, change plan, cancel, resume      |   ✓   |   —   |       —       |    —    |   —    |   —    |
| Delete organization                        |   ✓   |   —   |       —       |    —    |   —    |   —    |
| View members                               |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| Invite / revoke invitation                 |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| Change a member's role                     |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| Remove a member                            |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| **Projects**                               |       |       |               |         |        |        |
| Create                                     |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| Edit, archive                              |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| View                                       |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| Manage project members                     |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| **Requirements**                           |       |       |               |         |        |        |
| Create, edit, delete                       |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| Approve (status change)                    |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| View, view history                         |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| **Suites, sections, cases, steps**         |       |       |               |         |        |        |
| Create, edit, duplicate                    |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| Archive, delete                            |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| View                                       |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| **Test runs**                              |       |       |               |         |        |        |
| Create, close, delete                      |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| Assign cases to testers                    |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| Record a result                            |   ✓   |   ✓   |       ✓       |    ✓    |  own   |   —    |
| View                                       |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| **Defects**                                |       |       |               |         |        |        |
| Create                                     |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| Edit any                                   |   ✓   |   ✓   |       ✓       |    ✓    |  own   |   —    |
| Change status, assign                      |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| View                                       |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| **Traceability**                           |       |       |               |         |        |        |
| Create or remove links                     |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| View the matrix                            |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| **Audit log**                              |       |       |               |         |        |        |
| Read                                       |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| **Integrations**                           |       |       |               |         |        |        |
| Configure a connection                     |   ✓   |   ✓   |       —       |    —    |   —    |   —    |

## Where each rule is enforced

Two different mechanisms, and the distinction matters:

**Route-level** — the `✓`/`—` columns. Declared with `@Roles(...)` on the
handler and checked by `RolesGuard` before the handler runs. It only needs the
caller's role, so it needs no database read beyond the membership lookup the
organization guard already did.

**Object-level** — every `own`. "A tester may edit their own result but not
somebody else's" cannot be answered without loading the object, so it lives in
the service. Putting it in a guard would mean fetching the row twice and
scattering a business rule away from the code that owns it.

## Project-scoped roles

A row in `ProjectMember` says "inside this project, treat this person as _this_
role instead". It may raise or lower them, and it applies to exactly one
project. Revoking the row returns them to their organization role; there is no
separate "removed from project" state, because a member who can read every
project in the organization already could.

The effective role is resolved by `ProjectAccessService`:

```
effectiveRole(project) =
  organization_owner            -> organization_owner   (never narrowed)
  ProjectMember.role, if any    -> that role
  otherwise                     -> the organization role
```

Enforcement is split, and the split is forced by a real constraint rather than
chosen: for most routes the project is a property of the entity being touched
(`PATCH /test-cases/:id` names no project), so no guard can know it without
loading that entity.

1. `RolesGuard` checks the organization role. If it passes, the request
   continues.
2. If it fails on a route marked `@ProjectScoped`, the guard asks whether _any_
   grant the caller holds would allow the action. This is what makes a grant
   able to raise somebody, and it is deliberately weaker than the final answer.
3. The service loads the entity, resolves the project, and re-applies the very
   same `@Roles` list to the effective role — `assertRouteAccess()`. This is the
   authoritative check, and the resolved role is memoized per request.

The contract a `@ProjectScoped` route signs is therefore: it **must** reach
`assertRouteAccess()` before it writes. `POST /projects` is deliberately _not_
project-scoped — there is no project yet, so no grant may become permission to
create one.

Rules on granting, all enforced in `ProjectMembersService`:

- the target must be an active member of the organization;
- nobody grants a role more powerful than their own effective role here;
- nobody changes their own project role;
- an `organization_owner` is never narrowed;
- an archived project is read-only, including its access list;
- every grant, change and revocation is an audited `role_change`.

## Invariants that override the matrix

Rules that hold even for an owner:

- **The last owner cannot be removed or demoted.** An organization with no owner
  cannot be administered again without support intervention.
  (`OrganizationMembersRepository.countOwners`.)
- **Nobody can grant a role above their own.** An admin cannot mint an owner.
- **Test results are never editable or deletable**, by anybody. They are the
  historical record; a correction is a new result.
- **Audit entries are never editable or deletable**, by anybody.

## Granular permissions (S2-F8)

`effective = ROLE_PERMISSIONS[effective role] + project grants − project revokes`;
`organization_owner` always holds the whole catalogue. Overrides exist only per
(project, user) — never per organization.

| Permission             | owner | admin | proj. manager | qa_lead | tester | viewer |
| ---------------------- | :---: | :---: | :-----------: | :-----: | :----: | :----: |
| `requirements.read`    |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `requirements.write`   |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| `requirements.manage`  |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `test_design.read`     |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `test_design.write`    |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| `test_design.manage`   |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `testruns.read`        |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `testruns.create`      |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| `testruns.execute`     |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| `testruns.manage`      |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `defects.read`         |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `defects.create`       |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| `defects.manage`       |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `traceability.read`    |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `traceability.manage`  |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| `attachments.read`     |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `attachments.upload`   |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| `attachments.delete`   |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| `integrations.read`    |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `integrations.manage`  |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| `members.read`         |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `members.manage`       |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `project.manage`       |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `notifications.manage` |   ✓   |   ✓   |       —       |    —    |   —    |   —    |
| `analytics.read`       |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `test_design.import`   |   ✓   |   ✓   |       ✓       |    ✓    |   —    |   —    |
| `data.export`          |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `api_keys.manage`      |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `releases.read`        |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `releases.manage`      |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `customization.manage` |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |
| `work_items.read`      |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   ✓    |
| `work_items.write`     |   ✓   |   ✓   |       ✓       |    ✓    |   ✓    |   —    |
| `work_items.manage`    |   ✓   |   ✓   |       ✓       |    —    |   —    |   —    |

The table is `ROLE_PERMISSIONS` in `packages/shared`; it was derived from the
`@Roles` lists the routes carried before, so an installation without overrides
behaves exactly as it did. Object-level `own` rules above still apply on top.

Rules on overrides (`ProjectPermissionsService`): nobody edits their own; an
owner is never touched; nobody edits a member above their own effective role;
a grant must be a permission the actor effectively holds in that project;
archived projects are read-only; every change is an audited `role_change`.

### Import and export (S3-F1)

- `test_design.import` covers the dry run, the commit, the job history and the
  limits of `/projects/:projectId/imports`. A commit is also refused unless the
  caller is the member who ran the dry run and still holds the permission.
- Every CSV export needs `data.export` **and** the read permission of what it
  exports (`test_design.read`, `testruns.read` or `traceability.read`). Revoking
  `data.export` for one member in one project keeps their read access and
  removes only the downloads; the web client hides the export and print links.

### API keys and ingestion (S3-F3)

- `work_items.write` covers creating and editing work items, moving them
  between statuses, in the hierarchy and into open releases;
  `work_items.manage` adds soft deletion. Reordering the backlog and bulk
  edits need `work_items.write`.
- `customization.manage` covers creating, editing, archiving and restoring
  custom field definitions and saving the defect workflow of a project.
  Reading them needs only project visibility.
- `api_keys.manage` covers listing, creating and revoking the keys of a project
  and reading its ingestion history; it needs the project to be visible.
- A key is not a member: its only capability is the scope `results:ingest` on
  its own project. `POST /ingest/junit` and `/ingest/playwright` ignore user
  sessions and organization headers.

## Project visibility (S3-F2)

| Organization role                                | Sees a project when…                        |
| ------------------------------------------------ | ------------------------------------------- |
| `organization_owner`, `organization_admin`       | always, every project of the organization   |
| `project_manager`, `qa_lead`, `tester`, `viewer` | they hold a grant in it (`project_members`) |

- A grant with `role: null` gives access with the organization role; a grant
  with a role gives access with that role (narrower or wider, within the
  granter's own power).
- Removing a grant removes the project and its overrides immediately. Removing
  an organization member removes every grant and override they held there, so
  a reinvited member starts with no projects.
- A project the caller cannot see is answered like an id that does not exist:
  `GET /projects/:id` and every entity route return the same 404; lists that
  take a `projectId` return the same empty page; dashboards neither name nor
  count it. Archived projects follow the same rule.
- Overrides can only be set for a member who can see the project (409
  otherwise), and work (defects, run cases) can only be assigned to such a
  member (400), so a notification never names a project to a person who cannot
  open it.
- The project access page lists every organization member on purpose, with
  `hasAccess`: it is where access is given, and it needs `members.read` in a
  project the caller can see.

## Not implemented yet

- **Database-enforced project visibility.** RLS isolates organizations; project
  visibility is enforced by the services (debt 39).
- **Custom roles per customer.** The catalogue exists now; named, reusable
  permission sets per organization do not.
- **Organization-level overrides.** Deliberately out of S2-F8 (debt 34).
- **Denial auditing.** A burst of 403s is a useful signal, currently unrecorded.

### Releases (S3-F4)

- `releases.read` covers `GET /releases`, `/releases/:id`, `/:id/summary` and
  `/:id/traceability`; `releases.manage` covers create, edit and the
  `start`/`release`/`archive` transitions.
- Attaching a run to a release is a run edit (`testruns.manage`); the release
  must be open and in the same project. A release of a hidden project answers
  like a missing one.
