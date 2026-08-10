# Permissions matrix

Six roles, no granular permission system. The reasoning is in
[`backend-course/13-authorization-and-roles.md`](backend-course/13-authorization-and-roles.md);
the short version is that a resource/action permission engine is more machinery
than six roles justify, and the migration path keeps `@Roles` as the public API
of the decorator.

Roles are scoped to an **organization**, and may be overridden **per project**.
The same person can be a `qa_lead` in one organization and a `viewer` in
another — and, inside one organization, a `qa_lead` on the mobile project and a
`viewer` on the web one.

## Roles

| Role | Intended for |
| --- | --- |
| `organization_owner` | Whoever signed up. Billing and the organization's existence. |
| `organization_admin` | Day-to-day administration: members, projects, settings. |
| `project_manager` | Owns a project's scope: requirements, planning, releases. |
| `qa_lead` | Owns test design and execution planning. |
| `tester` | Executes tests and reports defects. |
| `viewer` | Read-only. Stakeholders, clients, auditors. |

## Matrix

`✓` allowed · `own` only the rows they created or are assigned · `—` denied

| Action | owner | admin | proj. manager | qa_lead | tester | viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Organization** | | | | | | |
| Rename, change plan | ✓ | — | — | — | — | — |
| Delete organization | ✓ | — | — | — | — | — |
| View members | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Invite / revoke invitation | ✓ | ✓ | — | — | — | — |
| Change a member's role | ✓ | ✓ | — | — | — | — |
| Remove a member | ✓ | ✓ | — | — | — | — |
| **Projects** | | | | | | |
| Create | ✓ | ✓ | — | — | — | — |
| Edit, archive | ✓ | ✓ | ✓ | — | — | — |
| View | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage project members | ✓ | ✓ | ✓ | — | — | — |
| **Requirements** | | | | | | |
| Create, edit, delete | ✓ | ✓ | ✓ | ✓ | — | — |
| Approve (status change) | ✓ | ✓ | ✓ | — | — | — |
| View, view history | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Suites, sections, cases, steps** | | | | | | |
| Create, edit, duplicate | ✓ | ✓ | ✓ | ✓ | — | — |
| Archive, delete | ✓ | ✓ | ✓ | ✓ | — | — |
| View | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Test runs** | | | | | | |
| Create, close, delete | ✓ | ✓ | ✓ | ✓ | — | — |
| Assign cases to testers | ✓ | ✓ | ✓ | ✓ | — | — |
| Record a result | ✓ | ✓ | ✓ | ✓ | own | — |
| View | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Defects** | | | | | | |
| Create | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Edit any | ✓ | ✓ | ✓ | ✓ | own | — |
| Change status, assign | ✓ | ✓ | ✓ | ✓ | — | — |
| View | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Traceability** | | | | | | |
| Create or remove links | ✓ | ✓ | ✓ | ✓ | — | — |
| View the matrix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Audit log** | | | | | | |
| Read | ✓ | ✓ | — | — | — | — |
| **Integrations** | | | | | | |
| Configure a connection | ✓ | ✓ | — | — | — | — |

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

A row in `ProjectMember` says "inside this project, treat this person as *this*
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
2. If it fails on a route marked `@ProjectScoped`, the guard asks whether *any*
   grant the caller holds would allow the action. This is what makes a grant
   able to raise somebody, and it is deliberately weaker than the final answer.
3. The service loads the entity, resolves the project, and re-applies the very
   same `@Roles` list to the effective role — `assertRouteAccess()`. This is the
   authoritative check, and the resolved role is memoized per request.

The contract a `@ProjectScoped` route signs is therefore: it **must** reach
`assertRouteAccess()` before it writes. `POST /projects` is deliberately *not*
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

## Not implemented yet

- **Per-project read restrictions.** A grant changes what somebody may *do* in a
  project, not whether they can see it: every member of the organization can
  read every project. Hiding a project is a different feature — it needs the
  tenant filter to gain a second dimension, and every list endpoint to respect
  it — and pretending a narrowed role hides data would be worse than saying so.
- **Custom roles per customer.** Requires the permission engine.
- **Denial auditing.** A burst of 403s is a useful signal, currently unrecorded.
