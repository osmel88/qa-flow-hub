# Technical debt and known limitations

Every entry here is a **conscious** decision, not an oversight. Each states what
is missing, why it was acceptable for the MVP, what it costs, and what would
trigger paying it off.

The list is maintained as the project grows; entries are added in the phase that
creates them. Resolved entries are **kept, not deleted**: the decision that was
reversed is more instructive than the one that stood, and a deleted entry is how
a project forgets that it once shipped without Row Level Security.

## Status at the close of the MVP

| # | Entry | Status | Blocked on |
| --- | --- | --- | --- |
| 1 | Rate limiting is per process | open | Redis |
| 2 | Attachments store metadata only | open | object storage |
| 3 | No background job runner | open | first slow operation |
| 4 | No email delivery | open | email provider |
| 5 | No Row Level Security | **resolved** | — |
| 6 | `exactOptionalPropertyTypes` disabled | **resolved** | — |
| 7 | ESLint without type information | **resolved**, with a remainder in tests | Zod-parsed test responses |
| 8 | `react-router` advisory | **resolved** upstream | — |
| 9 | `@scarf/scarf` install script denied | intentional, permanent | — |
| 10 | Invitation tokens in the response | open | email provider |
| 11 | Audit immutability only in code | **resolved** | external store, for the owner |
| 12 | Lazy invitation expiry | open | job runner |
| 13 | Single OpenAPI version | open | first external consumer |
| 14 | Links have no foreign keys | open, by design | integrity job |
| 15 | Deleted entities keep their links | **resolved** | — |
| 16 | Dashboard aggregates per request | open | measured p95 |
| 17 | Coverage counts links, not intent | open | customer reporting |
| 18 | Noop integration adapters | open | first Jira customer |
| 19 | No audit retention policy | open | table size or compliance export |
| 20 | Refresh token body transport | open | scoped API keys |
| 21 | Project roles not enforced | **resolved** | — |
| 22 | Project roles do not restrict reading | open | a customer needing it |
| 23 | Roles guard fails open on project routes | open | response interceptor |
| 24 | Three dependency advisories | open, unreachable | upstream peer ranges |

Seven of the twenty-four are closed, five of them during this delivery. The ones
that are **not** blocked on a product decision or a third party — 14, 16, 17, 19,
22, 23 and the remainder of 7 — are the honest backlog of this codebase.

---

## 1. Rate limiting is per process

`@fastify/rate-limit` uses an in-memory store
(`apps/api/src/main.ts`). With N API replicas the effective limit is N × `RATE_LIMIT_MAX`.

- **Why acceptable now:** a single instance, and the limiter's job in the MVP is
  to stop naive abuse and brute force, not to enforce a commercial quota. Login
  brute-force protection does *not* rely on it: failed attempts are counted per
  user in the database.
- **Cost:** the published limit is not exact under horizontal scaling.
- **Trigger to fix:** the second API replica. Requires a shared store — the
  first genuinely good reason to introduce Redis, which the product owner asked
  to be consulted about before adding.

## 2. Attachments store metadata only

`AttachmentMetadata` records file name, size, MIME type, checksum and a
`storageKey`, but nothing is uploaded anywhere.

- **Why acceptable now:** object storage adds credentials, a bucket lifecycle,
  virus scanning and signed URLs — a phase of its own.
- **Cost:** the most visible functional gap against TestRail and Xray. A tester
  cannot attach the screenshot of a failure, which is the single most common
  thing a tester wants to attach.
- **Trigger to fix:** first real pilot with users. Design is already implied by
  `storageKey`: S3-compatible storage with pre-signed upload URLs.

## 3. No background job runner

Everything happens inside the request.

- **Why acceptable now:** no operation in the MVP is slow enough to need
  deferring.
- **Cost:** the first import from CSV or TestRail, or the first Jira sync, will
  not fit in a request.
- **Trigger to fix:** any feature that takes more than ~2 seconds or calls a
  third party.

## 4. No email delivery

Invitations are created, stored and can be accepted, but nothing is sent. The
seam is documented where the invitation is created.

- **Why acceptable now:** explicitly out of scope for this version.
- **Cost:** an invited user must receive the link out of band.
- **Trigger to fix:** onboarding a team that is not sitting in the same room.

## 5. PostgreSQL Row Level Security is not enabled — resolved

Tenant isolation now has two layers. The first is unchanged: guards plus
`TenantAwareRepository`, which adds `organizationId` to every where clause. The
second is the database:

- the API connects at runtime as `qaflow_app`, a role that **owns nothing** and
  holds only row-level privileges, because PostgreSQL exempts a table's owner
  from its policies. Migrations, the seed and the test harness keep using the
  owner through `DATABASE_MIGRATION_URL`;
- every functional table has a `tenant_isolation` policy comparing
  `organizationId` with `current_setting('app.current_organization', true)`,
  which is NULL when unset — so a query that announces nothing reads nothing;
- the setting is applied **inside the transaction that carries the query**
  (`set_config(..., TRUE)`, batched by the `row-level-security` client
  extension). Per-connection would have been the leak the layer exists to
  prevent, because Prisma pools connections;
- `qaflow_app` also lacks `UPDATE`/`DELETE` on `audit_logs`, which closes the
  remainder of entry 11: it cannot disable the append-only triggers either.
- **Verified by** `apps/api/test/rls.int-spec.ts`, which logs in as `qaflow_app`
  and shows that an unfiltered query returns nothing, a cross-tenant read is
  empty, and cross-tenant `UPDATE`/`DELETE` change zero rows.

**What is deliberately not covered:** `users`, `sessions`, `organizations`,
`organization_members` and `organization_invitations` have no policy. They are
read before an organization exists in the request — logging in, listing your
organizations, previewing an invitation — so a policy keyed on the active
organization could only be satisfied by turning it off in those paths, which is
worse than not having it. Their isolation stays in the repository layer, covered
by `test/tenancy.int-spec.ts`.

- **Trigger to revisit:** a policy for those five tables keyed on the
  authenticated user rather than the organization, if an audit asks for it.

## 6. `exactOptionalPropertyTypes` is disabled — **resolved**

Enabled in `packages/config/tsconfig.base.json`. The prediction recorded here —
noise from Prisma and Zod, no real defects — was wrong: the whole monorepo
produced **6** errors, and four of them were places where "absent" and
"explicitly undefined" genuinely differ (a Fastify plugin that checks for the
key's presence, a Prisma `where` where `undefined` silently means "no filter").
The reason the number was small is that the codebase already spread optional
fields conditionally; the flag now enforces the convention instead of trusting
it.

## 7. ESLint does not use type information — **resolved**

`packages/config/eslint.base.js` uses `recommendedTypeChecked` with
`projectService`, so `no-floating-promises`, `no-misused-promises`,
`no-unsafe-enum-comparison` and the `no-unsafe-*` family are on.

What it caught: a status-code `switch` comparing a plain `number` against
`HttpStatus` members — reading as exhaustive while several cases could never
match — four type assertions that asserted nothing, and an assertion on
`String(requestBody)` that would have passed whatever the body contained.

### Remaining: the integration suite asserts on `any`

The `no-unsafe-*` rules are off for `apps/api/test/**` and `*.test.ts(x)`.
`response.json()` returns `any`, and ~780 of the 822 initial errors were that
single fact repeated. Casting each one would assert types nobody verified.

- **Cost:** a renamed response field does not fail the linter in tests, only the
  assertion that reads it.
- **Trigger to fix:** parse responses through the shared Zod contracts in the
  test helper. That types them *and* fails on contract drift, which is strictly
  better than casts — it is a change to ~800 assertions, so it belongs in its
  own piece of work.
- Tooling files (`*.config.ts`, `eslint.config.js`, `playwright.config.ts`) have
  type-checked rules disabled: they sit outside every tsconfig by design.

## 8. `react-router` advisory GHSA-qwww-vcr4-c8h2 — resolved

The RSC-mode advisory was never reachable here (this is a pure client-side SPA
with no RSC handler), and the entry existed because the only fix at the time was
a major published three days earlier. `react-router-dom@7.18.2` now carries the
fix inside the 7.x line, so `npm audit` no longer reports it and no major upgrade
was needed.

The lesson worth keeping: the advisory was aged out rather than patched in a
hurry, which was the right call *because* the reachability analysis said so. The
same reasoning does not license ignoring an advisory whose path is reachable —
see entry 24.

## 9. `@scarf/scarf` install script is denied

npm 11 requires install scripts to be allow-listed (`allowScripts` in the root
`package.json`). Six packages are approved because they need it (Prisma, SWC,
argon2, esbuild). `@scarf/scarf`, which reports installation telemetry, is
deliberately **not** approved.

- **Cost:** `npm install` prints a warning on every run.
- **Assessment:** the warning is the correct outcome. It is documented here so
  that nobody "fixes" it by approving the package.

## 10. Invitation tokens are returned in the API response

There is no email provider, so `POST /organizations/current/invitations` returns
the plaintext token and an `acceptUrl` in its response body. It is the only way
the inviter can pass the link to the invitee today.

- **Cost:** the token appears in the inviter's browser and in any log that
  records response bodies. It is single-use, expiring and bound to one email
  address, so the blast radius is one pending invitation — but a token that
  grants organization access should not travel this way.
- **Assessment:** acceptable for an MVP with no real users. Not acceptable in
  production.
- **Trigger to fix:** wiring the email provider described in
  [`integrations-roadmap.md`](integrations-roadmap.md). Removing `token` and
  `acceptUrl` from `CreatedInvitationView` is the definition of done.

## 11. Audit immutability is enforced only in application code — resolved

`AuditService` still has no `update` or `delete` method, and PostgreSQL now
enforces the same rule regardless of who is connected: three triggers on
`audit_logs` reject `UPDATE`, `DELETE` and `TRUNCATE` with
`audit_logs is append-only` (migration `20260816135824_audit_log_append_only`).
`TRUNCATE` has its own statement-level trigger because row triggers do not see
it, and it is the cheapest way to erase everything at once.

The remainder noted here — the API being the table owner, and therefore able to
`ALTER TABLE ... DISABLE TRIGGER` — was closed by the role separation in entry 5.
Runtime connects as `qaflow_app`, which holds `SELECT, INSERT` on `audit_logs`
and nothing else, so the guarantee is now a privilege as well as a trigger. The
integration harness still disables the triggers to clean up between tests, but it
does so as the **owner** and only with `NODE_ENV=test`.

- **What remains:** whoever holds the owner credential can still rewrite history,
  which no in-database mechanism can prevent.
- **Trigger to fix:** shipping entries to an external append-only store, which is
  the only real answer to "who watches the owner".

## 12. Invitation expiry is settled lazily

Overdue invitations move to `expired` when `expireOverdue()` runs, which happens
when somebody invites or lists invitations — not on a schedule.

- **Cost:** a row can sit in `pending` past its expiry date. Acceptance is safe
  regardless, because `findAcceptable` compares `expiresAt` against the clock
  instead of trusting the status, but a listing shown to an admin can be briefly
  stale.
- **Trigger to fix:** a scheduled job, once there is a job runner. Doing it now
  would add a scheduler for one query.

## 13. Single OpenAPI version

The API is versioned by URI (`/api/v1`) but only one version exists, and there
is no deprecation policy yet.

- **Trigger to fix:** the first external consumer that is not our own web
  client.

## 14. Traceability links have no foreign keys

`TraceabilityLink` is polymorphic (`sourceType` + `sourceId`), so PostgreSQL
cannot enforce that either end exists. The service checks that both endpoints are
**alive and in the active organization** before creating a link, deletion purges
the links of the entity in the same transaction (entry 15), and the matrix still
skips a link whose case it cannot find.

- **Cost:** a direct database write, or a future code path that forgets the
  check, can leave a link pointing at nothing. Nothing crashes, but the matrix
  quietly under-reports.
- **Trigger to fix:** a periodic integrity job, or a trigger per entity type,
  once link volume makes a silent gap expensive. Deliberate: the alternative is
  six join tables and a migration per new relation type.

## 15. Deleted entities keep their links — resolved

Soft-deleting a requirement, case, run or defect now deletes its links **inside
the same transaction** as the soft delete, in both directions, scoped to the
organization. Deleting a suite purges the links of the cases it takes with it,
and deleting a run purges the links of its results, which are unreachable once
their run is gone. The link row is removed rather than flagged: removing a link
by hand has always been a real `DELETE`, and `AuditLog` keeps the history,
including how many links went (`removedTraceabilityLinks`).

Archiving is deliberately different. An archived case **keeps** its link and
stays visible in the matrix flagged as archived, but it does not count towards
coverage or verification: a requirement whose only test is deprecated is not
tested today. Restoring the case brings the coverage back with no new link.

- **What remains:** links are still not constrained by the database, so a direct
  SQL write can create an orphan (entry 14).

## 16. Dashboard aggregates are computed on every request

Eight `count`/`groupBy` queries per call, all indexed, none loading rows. Fine at
current scale; not fine for an organization with hundreds of thousands of
results refreshing a dashboard every minute.

- **Trigger to fix:** measured p95 above ~300 ms. Then materialize per project
  and invalidate on write, which needs a job runner.

## 17. Coverage counts links, not intent

A requirement is "covered" if any link to a **live, non-archived** case exists.
Nothing checks that the case is meaningful or of the right depth.

- **Cost:** coverage can be gamed by linking one trivial case to everything.
  `verified` (executed, passed, no open defect) is the honest metric and is
  reported alongside it.
- **Trigger to fix:** risk-weighted coverage, when customers start reporting on
  it externally.

## 18. Integration adapters are contracts with noop providers

No provider talks to the network. Writes reject with
`IntegrationNotConfiguredError` and reads return empty, deliberately rather than
returning plausible fake data.

- **Cost:** `IntegrationConnection` rows can be created but do nothing;
  `secretRef` is stored and never resolved.
- **Trigger to fix:** the first paying customer that needs Jira. The work is one
  adapter plus a provider token swap in `IntegrationsModule`, not a migration.

## 19. The audit log has no retention policy

`audit_logs` grows without bound and is only exposed to owners and admins,
paginated, with no export.

- **Trigger to fix:** partitioning by month plus a retention window, before the
  table makes vacuum painful or a customer asks for a compliance export.

## 20. Refresh tokens still have a body transport

Browsers receive the refresh token as an `HttpOnly`, `SameSite=Strict` cookie
scoped to `/api/v1/auth`, and the response body carries `refreshToken: null`.
Clients without a cookie jar — the integration suite, CI scripts — opt into the
old behaviour with `X-Refresh-Transport: body`.

- **Cost:** two code paths for one credential, and a script that opts in holds a
  30-day token in memory with no rotation help from the browser.
- **Trigger to fix:** the first machine-to-machine consumer. The right answer for
  it is a scoped API key with its own lifecycle, not a session refresh token;
  once that exists, the header and the body transport can both go.

## 21. Project-scoped roles are not enforced — resolved

`ProjectMember` is now read on every project-scoped route: the effective role is
the grant if there is one and the organization role otherwise, and the route's
own `@Roles` list is re-applied to it (`ProjectAccessService`,
`@ProjectScoped`). Endpoints and UI exist to manage grants, and
[`permissions-matrix.md`](permissions-matrix.md) documents the resolution order.

What remains is narrower and listed as its own limitation below, because
conflating the two would make the matrix read as more restrictive than it is.

## 22. A project role does not restrict reading

Grants change what somebody may **do** in a project, never what they can
**see**: every member of an organization can read every project in it. This is
intentional for now — hiding a project means giving the tenant filter a second
dimension and auditing every list endpoint for it — but it is not what a
customer assumes when they set somebody to `viewer` on one project only.

- **Cost:** an organization cannot host two clients' projects side by side
  without both seeing each other's test data.
- **Trigger to fix:** the first customer asking for a project a colleague cannot
  open. It touches every list endpoint, so it is a phase, not a patch.

## 23. The roles guard fails open on project-scoped routes

On a route marked `@ProjectScoped`, a caller whose organization role is
insufficient still passes the guard when *any* grant they hold would allow the
action; the service then decides against the actual project. The alternative was
worse — with a strict guard a grant could only ever take power away — but it
means the guard is no longer the last line of defence on those routes.

- **Cost:** a project-scoped route that forgets to call `assertRouteAccess()`
  would let a grant holder act in a project where they hold nothing. Every route
  is covered today, and the integration suite asserts the asymmetry, but this is
  a convention rather than something the compiler enforces.
- **Trigger to fix:** an interceptor that fails the response when a
  project-scoped handler completed without resolving a project — cheap to add
  once, and it turns the convention into a check.

## 24. Three advisories with no upgrade path we can take

`npm audit` reports 5 high-severity findings, in three groups. None is fixable by
changing a version we control, so each is recorded with its reachability instead
of being "fixed" by a forced resolution:

**`@fastify/static` ≤ 10.1.1** (four advisories: path traversal in directory
listing, route-guard bypass via encoded separators and via traversal,
authorization bypass on non-canonical paths). The fixed line is 10.1.2+, and the
workspace does depend on a fixed version — but the copy that actually serves
requests is the one npm installs for the **optional peer** of
`@nestjs/platform-fastify`, whose range is `^8.0.0 || ^9.0.0`. Forcing 10.x with
an `overrides` entry leaves the tree in a state npm itself reports as invalid, so
it was reverted.

- **Reachability:** the only handler that serves static files is the Swagger UI
  mounted at `/docs`. The app never calls `useStaticAssets()`, so no application
  route is served from disk, and the assets exposed are Swagger's own.
- **Mitigation shipped:** `/docs` is now off by default in production, so the
  handler does not exist in a production deployment unless it is switched on
  deliberately (`SWAGGER_ENABLED=true`).
- **Trigger to fix:** `@nestjs/platform-fastify` widening its peer range to
  `^10`. Then a single hoisted copy is enough and the override becomes
  unnecessary.

**`deepmerge-ts` < 8 through `@prisma/config`** (stack exhaustion on recursive
object graphs). Reached only by the Prisma CLI while merging its own
configuration, from a file in this repository, at migration time — not from a
request, and not from customer input. The latest `@prisma/config` still pins
`deepmerge-ts@7.1.5`, so there is no version to move to.

**`nanoid` < 3.3.18 through `postcss` and Vite.** Build-time only, in the
frontend toolchain; it never ships in a bundle and never sees a request.

- **Cost of all three:** `npm audit` is not clean, so it cannot be a CI gate
  without a suppression file, and a suppression file is where real findings go to
  hide.
- **Trigger to revisit:** each upstream release. The check to run is
  `npm audit --omit=dev`, and the question to answer is always reachability, not
  the severity badge.
