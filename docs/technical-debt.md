# Technical debt and known limitations

Every entry here is a **conscious** decision, not an oversight. Each states what
is missing, why it was acceptable for the MVP, what it costs, and what would
trigger paying it off.

The list is maintained as the project grows; entries are added in the phase that
creates them. Resolved entries are **kept, not deleted**: the decision that was
reversed is more instructive than the one that stood, and a deleted entry is how
a project forgets that it once shipped without Row Level Security.

## Status at the close of the MVP

| #   | Entry                                                   | Status                                  | Blocked on                      |
| --- | ------------------------------------------------------- | --------------------------------------- | ------------------------------- |
| 1   | Rate limiting is per process                            | open                                    | Redis                           |
| 2   | Attachments store metadata only                         | open                                    | object storage                  |
| 3   | No background job runner                                | open                                    | first slow operation            |
| 4   | No email delivery                                       | open                                    | email provider                  |
| 5   | No Row Level Security                                   | **resolved**                            | —                               |
| 6   | `exactOptionalPropertyTypes` disabled                   | **resolved**                            | —                               |
| 7   | ESLint without type information                         | **resolved**, with a remainder in tests | Zod-parsed test responses       |
| 8   | `react-router` advisory                                 | **resolved** upstream                   | —                               |
| 9   | `@scarf/scarf` install script denied                    | intentional, permanent                  | —                               |
| 10  | Invitation tokens in the response                       | open                                    | email provider                  |
| 11  | Audit immutability only in code                         | **resolved**                            | external store, for the owner   |
| 12  | Lazy invitation expiry                                  | open                                    | job runner                      |
| 13  | Single OpenAPI version                                  | open                                    | first external consumer         |
| 14  | Links have no foreign keys                              | open, by design                         | integrity job                   |
| 15  | Deleted entities keep their links                       | **resolved**                            | —                               |
| 16  | Dashboard aggregates per request                        | open                                    | measured p95                    |
| 17  | Coverage counts links, not intent                       | open                                    | customer reporting              |
| 18  | Noop integration adapters                               | open                                    | first Jira customer             |
| 19  | No audit retention policy                               | open                                    | table size or compliance export |
| 20  | Refresh token body transport                            | open                                    | scoped API keys                 |
| 21  | Project roles not enforced                              | **resolved**                            | —                               |
| 22  | Project roles do not restrict reading                   | open                                    | a customer needing it           |
| 23  | Roles guard fails open on project routes                | **resolved** (PR #1 security round)     | —                               |
| 24  | Three dependency advisories                             | open, unreachable                       | upstream peer ranges            |
| 25  | Intermittent logout on full page loads                  | open, not reproducible                  | instrumentation                 |
| 26  | Destructive actions that only exist in the API          | open, partly closed                     | product decision per entity     |
| 27  | Integration settings without a credential store (S2-F1) | open, by design                         | S2-F4                           |

Seven of the twenty-seven are closed, five of them during this delivery. The ones
that are **not** blocked on a product decision or a third party — 14, 16, 17, 19,
22, 23, 25 and the remainder of 7 — are the honest backlog of this codebase.

---

## 1. Rate limiting is per process

`@fastify/rate-limit` uses an in-memory store
(`apps/api/src/main.ts`). With N API replicas the effective limit is N × `RATE_LIMIT_MAX`.

- **Why acceptable now:** a single instance, and the limiter's job in the MVP is
  to stop naive abuse and brute force, not to enforce a commercial quota. Login
  brute-force protection does _not_ rely on it: failed attempts are counted per
  user in the database.
- **Cost:** the published limit is not exact under horizontal scaling.
- **Trigger to fix:** the second API replica. Requires a shared store — the
  first genuinely good reason to introduce Redis, which the product owner asked
  to be consulted about before adding.
- **Found in S2-F7:** the plugin's rejection is not a `DomainError`, so
  `AllExceptionsFilter` reports it as `500 INTERNAL_ERROR` instead of `429`,
  and the web shows "An unexpected error occurred". The full Playwright suite
  (9 specs, one browser, ~50 s) now exceeds the default 300 requests/min, so
  CI and local E2E runs set `RATE_LIMIT_MAX=2000`. Mapping the plugin error to
  `RateLimitedError` (429 + `Retry-After`) is a small fix for the hardening
  phase (S2-F10).

## 2. Attachments store metadata only — closed in S2-F7

`AttachmentMetadata` recorded file name, size, MIME type, checksum and a
`storageKey`, but nothing was uploaded anywhere.

- **Resolution (S2-F7):** uploads, downloads and deletes exist behind a
  `StorageProvider` port with a local-disk implementation. What remains — no
  object storage, no signed URLs, no quotas — is entry 33.

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
  test helper. That types them _and_ fails on contract drift, which is strictly
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
hurry, which was the right call _because_ the reachability analysis said so. The
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
- **After S2-F9:** the analytics endpoints follow the same rule (grouped SQL,
  no rows) but run more statements per call — trends add five bucketed
  aggregates — and still nothing is cached or materialized. The MVP endpoint's
  coverage count no longer loads requirement ids.

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
- **After S2-F8:** revoking `requirements.read` (or any `*.read`) is enforced on
  the routes that resolve a project, but the project list and the dashboard's
  organization view still show every project of the organization.
- **After S2-F9:** the new organization analytics (`/dashboard/organization`)
  aggregates only projects where the caller holds `analytics.read`. The project
  list and the MVP `GET /dashboard` without `projectId` still do not filter.
- **After the PR #1 security round:** every list that takes a `projectId`
  (requirements, suites, sections, cases, runs, defects, links) now authorizes
  that project with the effective `*.read` permission before querying, and a
  missing `projectId` is rejected. The MVP `GET /dashboard` aggregates only
  projects where the caller holds `analytics.read`. What remains is the
  project list itself: every member still sees the names of every project in
  the organization (not their content).

## 23. The roles guard fails open on project-scoped routes — resolved

**Resolved in the PR #1 security round:** `ProjectScopeContractInterceptor`
(global) fails a `@ProjectScoped` handler with 403 when it completes without a
project access decision (`ProjectAccessService.assertRouteAccess`,
`authorizeProjectScope` or `projectsAllowing`). The convention below is now a
runtime check; the original description is kept for context.

On a route marked `@ProjectScoped`, a caller whose organization role is
insufficient still passes the guard when _any_ grant they hold would allow the
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
- **After S2-F8:** the shape is the same with permissions: the guard also passes
  when any project override *grants* the required permission somewhere, and a
  *revoke* is only applied by `assertRouteAccess`. The convention now carries
  more weight, which makes the interceptor more urgent, not less.

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

## 25. Intermittent logout on full page loads

> **PR #1 security round:** a confirmed cause of spurious logouts was fixed —
> two concurrent refreshes of the same token both rotated it, and the loser's
> reuse detection revoked the winner's family. `SessionsRepository.rotate()`
> now consumes the predecessor conditionally (`revokedAt IS NULL`); the loser
> gets a plain 401 and the winner's session survives. A later replay of the
> consumed token still revokes the family.

During the manual end-to-end session the client logged itself out twice while
navigating by typing a URL in the address bar with a valid session, and once on
`Ctrl+Shift+R`. Plain `F5` reloads never did it, and no sequence reproduced it on
demand. **No change was made to authentication**: a speculative fix to a login
system, validated by a bug that does not reproduce, is how a security control
becomes folklore.

- **Symptoms:** the app returns to the login screen mid-session; the next login
  succeeds normally, which rules out a corrupted account or a clock problem.
- **Standing hypothesis — refresh rotation, not expiry.** Refresh tokens rotate
  on every use, and presenting an already-rotated token is treated as theft:
  `AuthService.refresh` revokes the **whole family**
  (`revokeFamily(..., 'reuse_detected')`). Two concurrent `/refresh` calls with
  the same cookie therefore end the session rather than one of them losing a
  race. The client's guard against that (`ensureRefresh`, a module-level promise
  in `apps/web/src/api/http-client.ts`) only serialises calls **within one
  JavaScript context**, and a full page load creates a new one — which matches
  the observation that address-bar navigation and a hard reload failed while
  `F5` did not.
- **Cost:** rare, self-correcting, but indistinguishable to a user from the
  product forgetting who they are — and if the hypothesis is right, one stray
  concurrent refresh logs the user out of **every** device on that family.
- **How to instrument before touching auth:** log `familyId`, `sessionId` and
  the request id on every `/refresh`, and count how often two arrive for the
  same family within a second; the reuse-detection branch already logs, so the
  question is only whether that log line appears at the moment of a logout. If
  it does, the fix is a short reuse grace window for the immediately previous
  token of a family (the standard remedy) — a deliberate, tested weakening of
  rotation, not a guess.
- **Trigger to fix:** the log line above appearing in a real logout, or one
  reproducible sequence.

## 26. Destructive and restorative actions that only exist in the API

The API exposes more of the entity lifecycle than the client does. This was
invisible until the manual pass, because every one of these routes is covered by
integration tests and none of them had a button.

| Action               | API | UI                              |
| -------------------- | --- | ------------------------------- |
| Archive a test case  | yes | yes                             |
| Restore a test case  | yes | **yes, added in this delivery** |
| Delete a requirement | yes | no                              |
| Delete a test case   | yes | no                              |
| Delete a test run    | yes | no                              |
| Delete a defect      | yes | no                              |

Restoring a case was added because it is the counterpart of a button that
already exists, uses the same permission, and without it archiving is a one-way
door in the interface. The deletions were **not** added on the same reasoning:
they are soft deletes, but they purge traceability links in the same transaction
(entry 15), so the undo is not symmetrical and the screen needs a confirmation
step that says what else disappears. That is a product decision, and scope was
not widened to make it unilaterally.

- **Cost:** an organisation owner cannot correct a mistyped requirement or a
  duplicated run without calling the API.
- **Proposal when it is taken up:** one shared confirmation dialog that names
  the entity and the number of links that will be purged, wired to the existing
  `DELETE` routes; visible only to the roles the API already requires. It is a
  small change once the wording of the warning is agreed.
- **Trigger to fix:** the first pilot user who needs to undo something.

## 27. Integration settings without a credential store (S2-F1)

S2-F1 shipped `Settings → Integrations` on the approved premise that **no
credential is stored in this phase**. `IntegrationConnection.secretRef` exists
and is never written: the API accepts no token, rejects secret-like keys in
`settings`/`accountMetadata`, and returns only `hasCredential` (always `false`
today). The encrypted store, its key management and the token intake are
S2-F4's deliverable, and building a provisional version here would have fixed
the credential format before the only real consumer exists.

Consequences that follow from the same decision and are deliberate:

- **Connect** cannot connect anything. It persists the configuration, flips
  `enabled` and leaves the status `pending`; **Test connection** records
  `lastConnectionTestAt` and answers with the phase that delivers the provider
  instead of calling an adapter. No connection can reach `connected` until S2-F2,
  S2-F3 or S2-F4 land, and the UI says so on every card.
- The screen edits `settings` and `accountMetadata` as free `key=value` lines
  because the keys each provider needs are decided by the phase that implements
  it. A schema-driven form per provider replaces it once those phases exist.
- Uniqueness moved from `(organizationId, provider, displayName)` to
  `(organizationId, provider)`: one connection per provider and organization.
  Several Jira sites for one tenant is not a use case the roadmap has, and
  relaxing a unique index later is cheaper than de-duplicating rows.
- Availability per provider (which modes exist, which phase implements it)
  lives in a static table in the API, not in the database. It changes with a
  release, never with a customer action, so a table would be configuration
  disguised as data.

- **Cost:** the settings screen is complete but inert until the next phases;
  an owner can prepare the configuration and nothing else.
- **Trigger to fix:** S2-F2 (Jira mock flips `connectable` for `mock`), S2-F4
  (credential store, `hasCredential` becomes meaningful).

## 28. The Jira mock lives in memory (S2-F2)

`JiraMockStore` keeps its projects, users and issues in process memory, one
tenant at a time, and re-seeds itself on every start. That was the point: a
deterministic provider that tests can reason about (`10103`/`QA-3` is always the
first created issue) without a provider-specific table, migration or RLS policy
that S2-F3 would have to repeat for TestRail.

The `ExternalReference` rows it produces are real and persistent, so the two
sides drift on restart: a reference can point at an id the mock no longer has,
or — worse — at an id the mock has handed to somebody else's issue since. The
sync handles the first case (it recreates the issue and moves the reference,
recording `previousExternalId`); the second is indistinguishable from a
legitimate update and is not detected. A second API instance would have its own
mock as well.

- **Cost:** in development, "Re-sync" after an API restart silently updates the
  wrong mock issue when ids were reused; never a data-loss risk for internal
  entities, only for the mock's own state.
- **Trigger to fix:** a real Jira (ids are never reused there), or a request to
  keep mock state across restarts — then persist the store in a `jira_mock_*`
  schema behind the same `JiraMockStore` interface, with tenant isolation as a
  column, and drop the reset-on-start behaviour.

Also deliberate and cheaper to change later than to design now:

- Sync is one-directional and on demand (a button, no polling, no webhook): a
  change made in Jira is not pulled back. S2-F5 owns bidirectional traceability.
- The web hides no Jira action by role; the API refuses and the cell shows the
  message. The same convention the rest of the client follows until S2-F8.

## 29. The TestRail mock shares the Jira mock's shape — and its limits (S2-F3)

`TestRailMockStore` is the same idea as entry 28 with TestRail vocabulary: in
memory, one tenant map per organization, re-seeded on start, deterministic ids
(`2`/`3`/`2`/`2` for the first suite/case/run/result a test creates). Everything
in entry 28 about references outliving the mock across restarts applies here
verbatim, with one aggravation: TestRail results are append-only, so a result
reference whose id the mock has re-issued to another test cannot be detected as
stale — `fetchResult` finds _a_ result and the sync reports `unchanged`.

Decisions taken in this phase that are cheaper to revisit later than to design
now:

- **Runs spanning several suites.** TestRail ties a run to one suite. A
  qa-flow-hub run that mixes cases from two suites is pushed against the suite
  with the most cases; the others are dropped from the external run and listed
  in `metadata.skippedCases`. The honest alternative (a TestRail _plan_ with one
  run per suite) is a second object type and a second reference; nobody has
  asked for it yet.
- **Sections carry no reference.** They are matched by name inside the suite on
  every sync. Renaming a section internally therefore creates a new one in
  TestRail rather than renaming the old; the case moves, the empty section
  stays. A `test_section` `LinkableEntity` fixes it when it matters.
- **Only the latest result is offered for sync in the UI.** Older attempts can
  still be pushed through the API, out of order on the TestRail side. The screen
  keeps the tester on the happy path; the API keeps the door open.
- **No import (TestRail → qa-flow-hub).** `importCases` exists on the port and
  the mock answers it, but no service consumes it: the phase was approved as
  push-only. Import needs a dry run and a per-row report, and its result — a
  case owned elsewhere — is a traceability question S2-F5 has to answer first.
- **`TestManagementAdapter` grew to twenty methods.** It is one interface
  because the provider is one product; if a second test-management provider
  ever arrives, split it by entity (`SuiteSync`, `CaseSync`, …) before
  implementing it twice.

- **Cost:** development-only drift after restarts, as in 28; a multi-suite run
  looks complete in TestRail while it is not (the metadata says so, the UI does
  not yet).
- **Trigger to fix:** a real TestRail, or S2-F5 needing the import direction.

## 30. The GitHub mock imports results by tag, in memory (S2-F4)

`GitHubMockStore` is the third in-memory, per-organization, re-seeded-on-start
mock (entries 28 and 29 apply). Its ids are fixed rather than allocated (the
store is read-only for the product: nothing is created in GitHub), so the drift
described there is narrower — a reference can only go stale if the seed
changes — but the shape is the same and a real adapter will have to cope with
runs GitHub has purged (90 days of retention) exactly as `linkRun` does today
when `fetchWorkflowRun` returns `null`.

Decisions taken in this phase that are cheaper to revisit later than to design
now:

- **Matching is by `@C-n` tag against `<PROJECT>-C-n`.** The automated test
  says which case it covers by carrying the case number in its title, the
  Playwright convention for tags. It is fragile on purpose: a renumbered case, a
  case copied between projects or a tag typo silently becomes `case_not_in_run`
  or `no_case_tag`. The report makes it visible; nothing makes it impossible.
  The honest alternative — a `TestCase ↔ Automated Test` reference the tester
  confirms once — is the S2-F5 traceability line and must not be improvised in
  a mock phase.
- **A run links to one workflow run.** Linking a second one moves the reference
  (`previousExternalId`) instead of adding a row, so a nightly run that gathers
  several CI runs (retries, shards, matrix jobs) can only point at the last.
  Results already imported from the previous run stay: they are append-only and
  keyed by result id, so they are neither duplicated nor removed.
- **An imported `TestResult` looks like a manual one.** `executedById` is the
  member who pressed Import, not a bot; the comment carries the origin
  (`Automated (playwright / chromium) — acme/web-checkout#41 · …`) and the
  `ExternalReference` carries the metadata. Telling automated from manual
  results therefore means joining references. A provider-neutral `source`
  column on `TestResult` would be cleaner, but it is a migration on a business
  table decided for one provider; it waits for S2-F5 or S2-F9, whichever needs
  to filter automated results first.
- **No push in the other direction.** GitHub is read-only from the product's
  point of view: the mock exposes no create/update and the port has none. A
  real provider that annotates a check run or comments on a PR is a different
  port (`AutomationReporter`), not an extension of this one.
- **Jobs, artifacts and branches are browse-only.** They are listed through
  the API and covered by tests, but no screen shows them and no reference is
  created for them. They exist so the port is complete for the real adapter.
- **`settings.simulateFailure` is a real setting.** As with Jira and TestRail,
  an operator could set it on a mock connection in production. No real adapter
  will read it, and it disappears with the mocks.

- **Cost:** development-only drift after restarts, as in 28; a mistagged
  automated test is reported, never imported, and someone must read the report.
- **Trigger to fix:** GitHub Real (post-S2), or S2-F5 deciding how an
  automated test is bound to a case.

## 31. External traceability is derived, not verified (S2-F5)

The consolidated view computes each row's status from what the database
already knows — the reference, the entity's `updatedAt` and `archivedAt` /
`deletedAt`, the connection state — and only talks to the provider when
someone presses **Verify**. That is deliberate: a `GET` that calls three
providers per row would be slow, would fail with the provider and would need a
cache (entry 3) to be usable. But it means the table can be confidently wrong
until verified.

Decisions to revisit later rather than design now:

- **`stale` is "the internal side changed after the last sync".** The provider
  side changing is invisible until Verify runs, and even then the mock only
  says _present_ or _lost_: it does not compare fields. A real adapter would
  need a change marker (`updated` on Jira, `updated_on` on TestRail, the run's
  `updated_at`) and the row would need to store the one it last saw.
- **`projectId` on `ExternalReference` is denormalised.** It is copied from the
  entity at write time so a project can list its references — including the
  ones whose entity has been deleted — without six joins. Nothing moves
  entities between projects today, so nothing can desynchronise it; the day
  that exists, the move must update the references in the same transaction.
- **Missing rows are generated, not stored.** An entity a configured provider
  is expected to track and has not seen yet appears as `missing` with
  `referenceId: null`. The expectation table (Jira → requirements and defects,
  TestRail → suites, cases, runs; GitHub → runs) lives in the service, not in
  configuration: an organization that uses Jira for defects only will see
  every requirement as `missing` with no way to say "not expected".
- **Verify writes into `metadata`.** `verifiedAt` and `providerState` are
  stored on the reference so the audit trail stays on the row, next to
  `previousExternalId`. It is the third thing metadata carries (provider
  fields, re-link history, verification); when a fourth arrives, a
  `verifiedAt` column and a `history` table are the honest shape.
- **Duplicates are reported, never repaired.** Two references for the same
  entity and provider, or one external id shared by two entities, are `error`
  rows with `duplicate_reference` / `shared_external_id`. The current sync
  services cannot produce them (one row per entity is enforced there), so they
  can only come from a real importer or a manual fix; the view makes them
  visible and leaves the decision to a person.
- **`TestCase ↔ Automated Test` is still the tag.** The approved line exists
  in the view as the imported result's row (`externalKind: automated_test`),
  but the binding is still `@C-n` matching (entry 30). A confirmed, stored
  binding was left out to keep this phase from redesigning the GitHub import.
- **Re-sync in the web reuses the provider endpoints.** There is no
  `POST /traceability/resync`; the page calls Jira/TestRail sync or GitHub
  re-link with the row's entity. A generic endpoint would add a fourth place
  that knows which provider handles which entity.

- **Cost:** a row can read `synced` while the provider has silently changed or
  deleted the object; someone must press Verify, and on a large project Verify
  is O(references) provider calls with no batching.
- **Trigger to fix:** the first real adapter (change markers and batching), or
  S2-F9 wanting to count stale references without a manual Verify.

## 32. Email is mock-only, delivered in the request, with no retry (S2-F6)

S2-F6 built the whole notification path — typed domain events, recipients,
preferences, templates, a persistent `Notification` ledger and the
`EmailAdapter` port — but the only provider is `MockEmailAdapter` and
`EMAIL_PROVIDER` accepts nothing else. Nobody receives mail.

- **Synchronous, in-process delivery.** The listener renders, inserts the
  `pending` row and calls the adapter inside the request that raised the
  event. A listener failure is logged and swallowed, so the business write
  never fails because of mail — but a `failed` row stays `failed`: there is no
  retry, no backoff and nothing that drains `pending` rows left behind by a
  crash between insert and send. The ledger already has the columns an outbox
  worker needs (`status`, `attempts`, `attemptedAt`, `dedupeKey`); the worker
  and its scheduler are debt 3 and were deliberately not started here.
- **Debt 4 is downgraded, not closed.** Invitations still hand the token back
  in the API response (entry 10) because with a mock provider that is the only
  way the invitee gets the link. Entry 12 (lazy expiry) is untouched.
- **No password reset.** The product has no reset flow, so the security mail
  is "password changed"; a reset mail needs the reset endpoint first.
- **Preferences are global per user**, not per organization. A tester in two
  organizations cannot silence one of them.
- **Mock capture is in memory** (last 500 messages, lost on restart), like the
  Jira/TestRail/GitHub mocks (entries 28–30). The ledger persists; the bodies
  do not, by design.
- **Deduplication is a unique `dedupeKey` per event fingerprint**, so the same
  assignment is not mailed twice, but a rapid assign → unassign → assign of the
  same cases is one email, and two different partial assignments are two.

What activating real email requires, in order:

1. a credential source (the same store S2-F10 needs for GitHub real): the
   provider key must never be in `IntegrationConnection.settings` or in Git;
2. one class implementing `EmailAdapter` for the chosen vendor (SMTP, SES,
   Resend, SendGrid, Mailgun — the port is the same for all; no decision has
   been taken), registered under `EMAIL_ADAPTER` in `IntegrationsModule` and
   the `EMAIL_PROVIDER` enum widened;
3. a public base URL for the links the templates render (`acceptUrl`,
   `runUrl`, `defectUrl`) and a verified sender for `EMAIL_FROM`;
4. the outbox worker: drain `pending`/`failed` rows with bounded retries and
   move sending out of the request path;
5. then remove `token`/`acceptUrl` from `CreatedInvitationView` (closes 10),
   and consider bounce/complaint webhooks to flip `sent` → `failed` after the
   fact.

- **Cost:** mail is a developer-facing feature only; a transient provider
  error will be visible in the ledger but never recovered automatically.
- **Trigger to fix:** the first external user who must be invited by mail, or
  S2-F10.

## 33. Evidence lives on local disk behind the API (S2-F7)

S2-F7 made evidence real, but the only production-shaped provider is
`LocalStorageProvider`: bytes sit under `STORAGE_LOCAL_ROOT` on the API host.

- **Single host, no durability story.** The directory is not replicated and is
  not part of any backup; two API instances would see two different stores.
  A container restart keeps the files only if `./var/storage` is a mounted
  volume — `docker-compose.yml` does not mount one yet.
- **Downloads stream through the API.** There are no pre-signed or
  time-limited URLs: every byte of every screenshot passes through Node and
  through the session token. Safe, but it makes the API the bandwidth
  bottleneck and means a preview can never be a plain `<img src>`.
- **No quotas or retention.** `UPLOAD_MAX_SIZE_BYTES` limits one file; nothing
  limits an organization, a project or total disk. Soft-deleted rows point at
  already-deleted objects, and nothing sweeps objects whose row was never
  written (a crash between `put` and `create`) or rows whose object vanished.
- **Content validation is a magic-byte check**, not a scan. A PNG with a valid
  header and a malicious payload is accepted; PDFs can carry JavaScript. The
  `nosniff` + `attachment`-for-text headers stop the browser executing what we
  serve, not the tester's machine from opening what they download.
- **The migration emptied `attachment_metadata`.** Correct for this codebase
  (the MVP never wrote a row) but a deployment that had used the scaffold
  table would have lost its metadata; there is no backfill path.
- **`MemoryStorageProvider` is selectable at runtime** (`STORAGE_PROVIDER=memory`).
  Intended for tests; nothing prevents a misconfigured deployment from storing
  evidence in RAM.

What moving to S3-compatible storage requires — and what it does **not**:

1. one class implementing `StorageProvider` (`put`/`get`/`head`/`delete`)
   over the S3 API (AWS, R2, MinIO — same wire protocol, no vendor decision
   taken), registered in `StorageModule` under a new `STORAGE_PROVIDER` value;
   `AttachmentsService`, the controller, the repository and the web client do
   not change: they see keys and streams only;
2. credentials from the credential store S2-F10 introduces — never in
   `.env` committed to Git, never in `IntegrationConnection.settings`;
3. optionally a `presignGet(key, ttl)` method on the port for time-limited
   download URLs, with `LocalStorageProvider` returning `null` so the API
   keeps streaming where the provider cannot sign;
4. a migration script that copies existing local objects to the bucket and
   flips `storageProvider` on each row (the column exists for this);
5. a sweeper job (debt 3's runner) that reconciles rows and objects and
   applies retention;
6. per-organization quotas if evidence becomes a billable dimension (S2-F11).

- **Cost:** fine for development and a single-host pilot; not acceptable for a
  multi-instance deployment or for evidence that must survive the host.
- **Trigger to fix:** the first deployment with more than one API replica, or
  the first customer whose evidence must be retained under an SLA.

## 34. Project permission overrides: what S2-F8 leaves (S2-F8)

- **No organization-level overrides** — by decision. The organization is
  governed by roles; an override exists only per (project, user). This is a
  future extension, not a blocker: the table would gain a nullable `projectId`
  and the resolver one more layer.
- **Permissions are strings in the database.** `permission` is `text`
  validated by Zod on write and filtered with `isPermission` on read, so a
  renamed or removed permission leaves inert rows instead of failing a
  migration. There is no clean-up job for them.
- **Overrides do not follow the role.** Changing somebody's project role keeps
  their overrides; a grant that became redundant stays visible as an override.
  Removing a member from the organization cascades nothing yet — the rows stay
  until the project or user is deleted (inert, because the membership guard
  runs first).
- **Effective permissions cost two reads per request and project** (grants and
  overrides), memoized per request only. Fine at this size; a cache keyed on a
  membership version would be the next step if it shows up in traces.
- **`@Roles` and `@RequirePermission` coexist.** Organization routes still use
  roles; a route carrying both is satisfied by either. Migrating the remaining
  `@Roles` routes is mechanical but changes their semantics for nobody today,
  so it was left out.
- **No denial audit.** A 403 caused by a revoke is not recorded (same as
  before; see the permissions matrix).

- **Cost:** low today; the string column and the role/override drift are the
  two things a support engineer will meet first.
- **Trigger to fix:** custom roles (S2-F11 plans) or the first request for an
  organization-wide exception.

## 35. Analytics are computed live, in UTC, from internal data only (S2-F9)

- **Computed on every request.** No cache, no materialized views, no new
  indexes: the existing `organizationId`/`projectId`/status indexes serve the
  grouped statements, and nothing was measured yet that justifies more. A
  dashboard load issues ~6 project requests in parallel, each one transaction.
- **UTC buckets only.** A team in UTC−8 sees a day bucket that starts at 16:00
  local time. A `tz` parameter needs `date_trunc(..., AT TIME ZONE)` and a
  validated IANA zone.
- **Run scope is "alive in the window"**, not "executed in the window": the
  current distribution uses each case's latest status even if that result
  predates `from`. Trends, by contrast, count results by `executedAt`. Both are
  documented; a customer may still expect one definition everywhere.
- **Coverage is link coverage** (entry 17): the history counts a requirement
  from the bucket of its first link and does not see links that were later
  removed (deleted links are gone). A `verified` series is not in analytics yet.
- **Activity covers results, defects and runs** — not requirements, cases or
  traceability changes — and is capped at 15 items without paging.
- **Charts are hand-rolled SVG** with a data table each; no tooltips, zoom or
  export (CSV/PDF). Adding a chart library is a product decision, not needed
  for accessibility.
- **No external sources.** Jira, TestRail, GitHub Actions and Playwright are not
  aggregated; the contracts keep sources out of the response shape so a feed
  can add a series without breaking the page.
- **The MVP `GET /dashboard` stays**, unused by the web, for compatibility. It
  should be removed or redirected once nothing calls it.

- **Cost:** low at current scale; time zone and run-scope semantics are the
  first questions a customer report will raise.
- **Trigger to fix:** measured p95 over ~300 ms (materialize, with the job
  runner of entry 3), the first non-UTC customer, or the first external source.
