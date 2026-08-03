# Permissions matrix

Six roles, no granular permission system. The reasoning is in
[`backend-course/13-authorization-and-roles.md`](backend-course/13-authorization-and-roles.md);
the short version is that a resource/action permission engine is more machinery
than six roles justify, and the migration path keeps `@Roles` as the public API
of the decorator.

Roles are scoped to an **organization**. The same person can be a `qa_lead` in
one organization and a `viewer` in another.

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

- **Per-project roles.** `ProjectMember` exists in the schema and is not yet
  consulted by the guards: today a `qa_lead` is a `qa_lead` in every project of
  the organization. Narrowing by project is the first extension.
- **Custom roles per customer.** Requires the permission engine.
- **Denial auditing.** A burst of 403s is a useful signal, currently unrecorded.
