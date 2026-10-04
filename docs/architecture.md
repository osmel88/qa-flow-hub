# Architecture

## Shape

A **modular monolith**: one deployable API process, split internally into
modules with explicit boundaries, backed by one PostgreSQL database. Plus a
static React client that consumes the API and nothing else.

```
                    ┌───────────────────────┐
  browser ────────► │ web (React + Vite)    │
                    │ served by nginx       │
                    └──────────┬────────────┘
                               │ /api/v1  (same origin in deployment)
                    ┌──────────▼────────────┐
                    │ api (NestJS/Fastify)  │
                    │  guards → services    │
                    │  → repositories       │
                    └──────────┬────────────┘
                               │ Prisma
                    ┌──────────▼────────────┐
                    │ PostgreSQL 16         │
                    └───────────────────────┘
```

Why not microservices: the modules share one transactional boundary (creating a
defect from a failed result touches three tables and must be atomic) and one
team. Distributing that would buy independent scaling we do not need and pay for
it with distributed transactions we cannot afford. See
[`adr/0007-modular-monolith.md`](adr/0007-modular-monolith.md).

## Request lifecycle

```
Fastify
 → @fastify/helmet          security headers
 → @fastify/cors            configurable origins
 → @fastify/rate-limit      in-process limiter
 → RequestContext           requestId, ip, userAgent (AsyncLocalStorage)
 → JwtAuthGuard             verifies the access token, loads the user
 → ActiveOrgGuard           resolves the active organization and checks membership
 → OrgRolesGuard            @Roles(...) on the handler
 → ZodValidationPipe        strict whitelist → mass assignment is impossible
 → Controller               HTTP ⇄ use case, no business logic
 → Service                  business rules, transactions, emits domain events
 → Repository               Prisma; injects organizationId into every query
 → PostgreSQL
 ← AuditInterceptor         persists AuditLog for annotated actions
 ← AllExceptionsFilter      maps any failure to { error: { code, message } }
```

Two properties of that order are load-bearing:

- **Authorization runs before validation.** Someone without permission is not
  told which fields are malformed.
- **The tenant filter is applied in the repository, not in the service.**
  Services can be careless; repositories cannot. See
  [`security-model.md`](security-model.md).

## Backend layout

```
apps/api/src/
├─ main.ts                 bootstrap: adapter, plugins, prefix, versioning
├─ app.module.ts           the single composition root
├─ config/                 Zod-validated environment + typed facade
├─ database/               PrismaService, transactions, tenant-aware base repository
├─ common/                 guards, interceptors, pipes, decorators
├─ errors/                 domain error hierarchy + the one exception filter
├─ events/                 in-process event bus, typed domain events and DomainEventsPublisher (S2-F6)
├─ audit/                  AuditService and the interceptor that feeds it
├─ integrations/           adapter ports, no-op implementations, jira-mock/ (S2-F2), testrail-mock/ (S2-F3), github-mock/ (S2-F4), email-mock/ (S2-F6)
├─ modules/integrations/   Settings → Integrations (S2-F1) + Jira sync (S2-F2) + TestRail sync (S2-F3) + GitHub sync (S2-F4) + external traceability (S2-F5)
├─ modules/notifications/  domain event → recipients → preferences → template → ledger → EmailAdapter (S2-F6)
├─ storage/                StorageProvider port, LocalStorageProvider, MemoryStorageProvider, StorageModule (S2-F7)
├─ modules/attachments/    multipart upload → inspection → provider → AttachmentMetadata; authenticated download (S2-F7)
└─ modules/<area>/         controller, service, repository, dto, domain, policies
```

Rules that keep the boundaries real:

1. A module never imports another module's **repository**. It imports the module
   and uses its exported **service**.
2. A service never touches `PrismaClient` directly. It goes through a repository
   that carries the organization filter.
3. Controllers contain no `if` about business rules.
4. Cross-cutting behaviour is registered globally, never copy-pasted per
   endpoint.

## Frontend layout

```
apps/web/src/
├─ app/          providers and router
├─ pages/        one directory per screen
├─ features/     data hooks and forms per domain area
├─ components/   app-specific components
├─ api/          typed fetch client, one wrapper for the whole app
└─ lib/          pure helpers
```

State: **TanStack Query owns server state**; React state owns UI state. There is
no Redux, because in this application almost everything on screen is a cached
copy of server data, which is precisely what Query manages. Introducing Redux
would mean maintaining a second copy of the same truth.

## Shared contracts

`packages/shared` holds the Zod schemas both sides import: pagination, the error
envelope, enums and (as modules land) request/response shapes. A change there
breaks whichever side is now inconsistent, in the same commit.

## Multi-tenancy

Row-level, shared schema: every functional table carries `organizationId`, even
when it could be derived through `projectId`. The redundancy buys a filter with
no joins and a rule that can be verified mechanically. See
[`adr/0006-multi-tenancy-strategy.md`](adr/0006-multi-tenancy-strategy.md) and
[`security-model.md`](security-model.md).

PostgreSQL Row Level Security is **not** used in the MVP — it interacts poorly
with connection pooling under Prisma and complicates migrations — but the schema
makes it possible to enable later without a data model change.

## Extension points

| Point                         | Contract                                      | MVP implementation                                                                                          |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Issue trackers                | `IssueTrackerAdapter`                         | No-op; raises `INTEGRATION_NOT_CONFIGURED`                                                                  |
| Test management import/export | `TestManagementAdapter`                       | No-op                                                                                                       |
| Automation providers          | `AutomationProviderAdapter`                   | No-op                                                                                                       |
| External identity             | `IntegrationConnection` + `ExternalReference` | Tables and contracts only                                                                                   |
| Email                         | `EmailAdapter` (`send(EmailMessage)`)         | `MockEmailAdapter` (S2-F6): in-memory capture, deterministic ids, `+bounce`/`+defer` failures; no real mail |
| File storage                  | `StorageProvider` (`put/get/head/delete`)     | `LocalStorageProvider` (S2-F7): disk under `STORAGE_LOCAL_ROOT`; `MemoryStorageProvider` for tests          |

## Notifications (S2-F6)

Business modules publish facts, never mail. `DomainEventsPublisher` (over
`@nestjs/event-emitter`, in-process, `emitAsync`, listener errors logged and
swallowed so a notification failure cannot fail the business write) carries
five typed events: `organization.invitation.issued`, `user.password.changed`,
`test_run.cases.assigned`, `defect.assigned`, `defect.status.changed`.

`NotificationsService` listens and runs each pipeline **inside the event's
organization context** (`TenantContextService.runForOrganization`), not the
request's:

```text
event → recipients → type/category + preference decision → typed template
      → Notification row (pending, unique dedupeKey) → EmailAdapter
      → sent | failed | skipped
```

- `Notification` is a persistent ledger, not a queue: one row per attempt
  with `status`, `attemptedAt`, `deliveredAt`, `failureReason`,
  `skipReason`, `provider`, `providerMessageId` and non-sensitive `metadata`.
  Bodies and links are not stored. `organizationId` is nullable for account
  level mail (password changed); RLS lets an organization see only its rows
  and account-level rows only with no organization in context.
- `NotificationPreference` is per user, global (not per organization):
  `emailEnabled`, `testRunAssignments`, `defectAssignments`, `statusChanges`,
  all default on. Security mail (invitation, password changed) ignores them.
- Delivery is synchronous and in-process. There is no retry, no durable
  queue and no worker (see technical debt 32); the ledger is what a future
  outbox worker would drain.
- `EMAIL_PROVIDER` accepts only `mock`. A real provider is one class
  implementing `EmailAdapter`, registered in `IntegrationsModule`, plus a
  credential source that does not exist yet (post-S2, with S2-F10).

## Evidence storage (S2-F7)

```text
web (FormData) → POST /attachments → AttachmentsService → STORAGE_PROVIDER → disk | memory
                                            └─ AttachmentMetadata (PostgreSQL: metadata, never bytes)
```

The service resolves the target (`test_result | defect | test_run | test_case`)
through the tenant-aware repository, asserts project access, then streams the
multipart part through an inspector (SHA-256, byte count, magic bytes, NUL
scan) straight into `StorageProvider.put` under a generated key
(`org/<org>/project/<project>/<entity>/<uuid>.<ext>`). Anything that fails
inspection is deleted from storage before the error leaves. Download is
`GET /attachments/:id/content`: authorization first, then `storage.get`
streamed back with `nosniff`, `private, no-store` and a safe
`Content-Disposition` — the browser never sees a path or a bucket. Delete is
physical first, then `deletedAt`.

The port has no notion of paths, URLs or buckets, so an S3-compatible provider
is one more class in `storage/` plus a `STORAGE_PROVIDER` value; the module,
the controller and the web client stay as they are (debt 33 lists the rest).

## Granular permissions (S2-F8)

```text
RolesGuard (pre-filter)          ProjectAccessService (decision)
  @Roles / @RequirePermission  →   effectiveRole(project)
  org role satisfies? → pass         owner → everything
  @ProjectScoped and any grant       ProjectMember.role ?? org role
  or override could? → pass          ROLE_PERMISSIONS[role] + grants − revokes
  otherwise 403                    assertRouteAccess(project) → 403 or continue
```

The guard cannot know the project of `PATCH /defects/:id` without loading the
defect, so it only rejects what no grant could ever allow; the service resolves
the project and calls `assertRouteAccess`, which compares the route's metadata
(stored per request in `TenantContextService`) with the **effective** set.
A revoke therefore passes the guard (the organization role allows it) and is
refused by the service. Effective roles and permissions are memoized per
request and project. The catalogue and the role presets live in
`packages/shared`, so the web renders the same matrix the API enforces — the
UI only decides what to show.

Flows that run before the caller has an organization header (creating an
organization, accepting an invitation) announce the target organization with
`TenantContextService.runForOrganization` before writing tenant rows such as
the audit entry; otherwise RLS rejects them under the runtime role.

## Operations

Docker Compose runs PostgreSQL (dev), PostgreSQL (test, tmpfs, port 5433), the
API and nginx serving the web bundle. CI runs three jobs — static checks,
integration against a real PostgreSQL, and end-to-end against the production
build. See [`deployment.md`](deployment.md) and
[`backend-course/32-ci-cd.md`](backend-course/32-ci-cd.md).

## Known architectural limits

Tracked with their consequences in [`technical-debt.md`](technical-debt.md).
The three worth knowing before reading any code:

1. Rate limiting is **per process**. With N replicas the effective limit is N×.
2. There is **no background job runner**. Anything slow would block a request.
3. Attachments store **metadata only**.
