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
├─ events/                 in-process event bus and event contracts
├─ audit/                  AuditService and the interceptor that feeds it
├─ integrations/           adapter ports + no-op implementations
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

| Point | Contract | MVP implementation |
| --- | --- | --- |
| Issue trackers | `IssueTrackerAdapter` | No-op; raises `INTEGRATION_NOT_CONFIGURED` |
| Test management import/export | `TestManagementAdapter` | No-op |
| Automation providers | `AutomationProviderAdapter` | No-op |
| External identity | `IntegrationConnection` + `ExternalReference` | Tables and contracts only |
| Email | Invitation records exist without delivery | Documented seam, no provider |
| File storage | `AttachmentMetadata` with `storageKey` | Metadata only |

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
