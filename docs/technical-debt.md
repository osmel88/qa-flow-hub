# Technical debt and known limitations

Every entry here is a **conscious** decision, not an oversight. Each states what
is missing, why it was acceptable for the MVP, what it costs, and what would
trigger paying it off.

The list is maintained as the project grows; entries are added in the phase that
creates them.

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

## 5. PostgreSQL Row Level Security is not enabled

Tenant isolation is enforced in the application (guards + repository base
class), not by the database.

- **Why acceptable now:** RLS interacts badly with connection pooling under
  Prisma (the session variable must be set per connection, not per transaction)
  and complicates migrations.
- **Cost:** a raw query written outside the repository layer could bypass
  isolation. Mitigated by the repository base class, a lint rule against direct
  Prisma use in services, and a dedicated cross-tenant test suite.
- **Trigger to fix:** a customer with a compliance requirement for
  defence-in-depth at the database level. The schema already supports it: every
  functional table carries `organizationId`.

## 6. `exactOptionalPropertyTypes` is disabled

See `packages/config/tsconfig.base.json`.

- **Why acceptable now:** Prisma's generated types and Zod outputs model
  optional fields as `T | undefined`; enabling it produces noise without
  catching real defects.
- **Cost:** the distinction between "absent" and "explicitly undefined" is not
  enforced by the compiler.
- **Trigger to fix:** when Prisma models optionality more precisely.

## 7. ESLint does not use type information

Type-aware rules (`no-floating-promises`, `no-misused-promises`) are off.

- **Why acceptable now:** `npm run typecheck` already runs strict `tsc` over
  every package, and type-aware linting roughly triples lint time.
- **Cost:** a forgotten `await` on a promise-returning call is not caught by the
  linter.
- **Trigger to fix:** the first production bug caused by a missing `await`.

## 8. `react-router` advisory GHSA-qwww-vcr4-c8h2

`npm audit` reports 2 high-severity findings, both from the same advisory in
`react-router` (RSC mode CSRF bypass), reachable through `react-router-dom@7`.

- **Assessment:** this application is a pure client-side SPA. It does not use
  React Server Components, does not run the RSC request handler, and has no
  server-side action processing — the vulnerable code path is not reachable.
- **Why not fixed now:** the fix is `react-router@8.3.0`, published three days
  before this was written. Adopting a major version that fresh is a bigger risk
  than the advisory itself; the project's rule is to prefer dependency versions
  published at least a week ago. Downgrading is worse: versions below 7.12
  carry eleven *other* advisories.
- **Trigger to fix:** upgrade to `react-router` 8.x once it has settled, in a
  dedicated pull request with the end-to-end suite as the safety net.

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

## 11. Audit immutability is enforced only in application code

`AuditService` has no `update` or `delete` method, so nothing in the codebase can
modify an entry. The database, however, would happily accept an `UPDATE` from
anyone holding the application's credentials.

- **Cost:** an attacker with database access could erase their tracks.
- **Trigger to fix:** a dedicated database role for the API with
  `GRANT INSERT, SELECT` and no `UPDATE`/`DELETE` on `audit_logs`, or shipping
  entries to an append-only store. Needed before the first compliance audit.

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
