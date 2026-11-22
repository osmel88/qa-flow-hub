# 76 — Session capabilities, real membership status and conflict details

Three small API changes from the second staging-stabilization block. Each
one removes a guess the Web client was making.

## 1. One rule, two readers: `PROJECT_CREATOR_ROLES`

`POST /projects` is guarded by `@Roles(...)`. The Web wanted to disable the
"Create project" button for roles that would get a 403, and the first version
copied the role list into the page. Two copies drift.

The rule now lives once, in `packages/shared/src/auth/auth.contracts.ts`:

```ts
export const PROJECT_CREATOR_ROLES = ['organization_owner', 'organization_admin'] as const;
export function canCreateProjects(role: OrganizationRoleName): boolean { … }
```

- `projects.controller.ts` uses `@Roles(...PROJECT_CREATOR_ROLES)` — the guard.
- `UsersRepository.listOrganizations()` adds
  `capabilities: { createProjects: canCreateProjects(role) }` to every
  `OrganizationSummary` in the session (`/auth/login`, `/auth/refresh`,
  `/auth/me`).
- The Web reads `activeOrganization.capabilities.createProjects`. If the field
  is missing (a session stored by an older client) it enables the form and lets
  the API answer.

The capability is a _hint_. The guard still runs on every request, so a stale
or forged flag can only change what the button looks like.

Why a capability instead of sending the role list to the client? The client
should ask "may I do X?", not re-implement "which roles may do X". The day the
rule depends on the plan or an override, only the server changes.

## 2. `GET /auth/memberships`: listing is not authorizing

The session's `organizations` is filtered to `status = active` on purpose: the
organization switcher and the active-organization guard trust that list.
Adding suspended memberships there would make every consumer re-check status.

So the profile gets its own read:

```
GET /auth/memberships → MembershipView[]
  { organizationId, organizationName, role, status: 'active' | 'suspended' }
```

It returns only the caller's own memberships (filtered by `userId` from the
access token, never from input), skips soft-deleted memberships and
organizations, and grants nothing. Tenant isolation holds because the query is
keyed by the authenticated user, exactly like `listOrganizations()`.

## 3. Structured conflict details

`DuplicateResourceError(resource, field)` now also puts
`details: [{ path: field, message }]` in its context, which the exception
filter already copies to the response body. Registration with a taken email
answers:

```json
{ "error": { "code": "DUPLICATE_RESOURCE", "details": [{ "path": "email", … }] } }
```

The Web branches on `code` + `details[].path`, never on the English message,
and shows "Ya existe una cuenta con este correo electrónico." in Spanish.

Enumeration: registration already disclosed a taken email through the 409;
the change only makes it machine-readable. Login and password reset keep their
generic answers. Fully hiding it would require a verify-by-email signup.

## Exercises

1. Add `capabilities.manageMembers` and use it on the Members page. Which
   guard owns the rule today?
2. Write an integration test proving that `GET /auth/memberships` never
   returns another user's membership in the same organization.
3. Make `DuplicateResourceError` accept several fields for composite unique
   keys. What should `details` look like?
