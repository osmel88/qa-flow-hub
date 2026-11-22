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

## From one flag to a capability map

The first version had a single `PROJECT_CREATOR_ROLES` list. Billing, members,
audit log and notifications each repeated `role === 'organization_owner' ||
role === 'organization_admin'` in both the API and the Web. They now share one
table:

```ts
export const ORGANIZATION_CAPABILITY_ROLES = {
  createProjects: ['organization_owner', 'organization_admin'],
  manageOrganization: ['organization_owner'],
  manageMembers: ['organization_owner', 'organization_admin'],
  readBilling: ['organization_owner', 'organization_admin'],
  manageBilling: ['organization_owner'],
  readAuditLog: ['organization_owner', 'organization_admin'],
  inspectNotifications: ['organization_owner', 'organization_admin'],
  seeEveryProject: ['organization_owner', 'organization_admin'],
} as const satisfies Record<string, readonly OrganizationRoleName[]>;
```

- Controllers: `@Roles(...ORGANIZATION_CAPABILITY_ROLES.manageBilling)`.
- Services: `hasOrganizationCapability(role, 'seeEveryProject')`.
- Session: `capabilities: organizationCapabilities(membership.role)`.
- Web: `hasCapability(activeOrganization, 'readBilling')`, which falls back to
  `organizationCapabilities(role)` when an older stored session has none.

Adding a capability is one line in the table plus the guard that uses it; the
`satisfies` clause rejects a role that does not exist.

## Keeping the session fresh after a role change

The guards read the membership from the database on every request, so the API
is never wrong about a demoted user. The Web, however, renders from the
session it loaded at login. `AuthProvider` reloads `/auth/me` (and invalidates
`['permissions', 'me']`) when the tab regains focus (throttled to 30 s), every
5 minutes, and right after any 403 — subscribing to the TanStack query and
mutation caches, so no page has to remember to do it. A push channel
(WebSocket/SSE) would make it instant; it is not worth a new transport yet.

## Exercises

1. Add a `manageEnvironments` capability. Which guards and Web controls change,
   and what does the `satisfies` clause protect you from?
2. Write an integration test proving that `GET /auth/memberships` never
   returns another user's membership in the same organization.
3. Make `DuplicateResourceError` accept several fields for composite unique
   keys. What should `details` look like?
