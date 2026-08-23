# Security model

What is implemented, what is deliberately not, and why. Claims here are backed
by tests in `apps/api/test/`; anything not implemented is listed as such rather
than described in the future tense.

## Threat model

| Threat | Control | Where |
| --- | --- | --- |
| Cross-tenant data access | Row-level filter injected by the repository base, plus RLS policies enforced against a non-owning role | `tenant-aware.repository.ts`, `tenancy.int-spec.ts`, `rls.int-spec.ts` |
| Rewriting the audit trail | Append-only triggers on `audit_logs`; the API role cannot disable them | `20260816135824_audit_log_append_only`, `dashboard.int-spec.ts`, `rls.int-spec.ts` |
| Credential stuffing | Argon2id, per-account lockout, rate limiting | `password.service.ts`, `auth.service.ts` |
| Account enumeration | Identical error and identical timing | `auth.service.ts` (`wasteTime()`) |
| Stolen refresh token | Rotation with family revocation on reuse | `auth.service.ts`, `sessions.repository.ts` |
| Stale authorization | Session and membership checked per request | `jwt-auth.guard.ts`, `active-organization.guard.ts` |
| Mass assignment | Zod strips unknown keys | `zod-validation.pipe.ts` |
| Injection | Parameterised queries via Prisma | Repositories |
| Information disclosure in errors | Single exception filter, no internals | `all-exceptions.filter.ts` |
| Secrets in a database dump | Password hashes, token HMACs, `secretRef` only | Schema |

## Authentication

- **Passwords**: argon2id, 19 MiB / 2 iterations / 1 lane (OWASP baseline),
  with transparent rehashing on login when the parameters are raised.
- **Access token**: JWT, HS256, 15 minutes by default. Carries `sub`, `sid`,
  `email` — no roles, because roles change and a token cannot be un-issued.
- **Refresh token**: 256 bits of randomness, opaque, stored as HMAC-SHA256
  keyed with `JWT_REFRESH_SECRET`. Rotated on every use.
- **Reuse detection**: presenting an already-rotated token revokes the whole
  session family. We cannot distinguish the victim from the thief, so both
  re-authenticate.
- **Revocation**: the authentication guard reads the session row on every
  request, so logout, "log out everywhere" and password changes are immediate
  rather than eventual.
- **Lockout**: `failedLoginAttempts` and `lockedUntil` on the user row, so it
  survives a restart and is shared by every instance — unlike an in-memory
  counter.

## Authorization

Three global guards, in this order: authentication → active organization →
role. Global so that authentication is the default and `@Public()` is the
exception; forgetting a decorator then breaks an endpoint loudly instead of
publishing it silently.

The active organization arrives in the `X-Organization-Id` header and is
verified against `organization_members` on every request. It is not in the
token, so revoking a membership takes effect immediately and switching
organization does not require new tokens.

Object-level rules ("a tester may edit their own result") live in services,
where the object is loaded — not in guards.

## Tenant isolation

The single largest risk in a shared-schema SaaS. See
[`adr/0006-multi-tenancy-strategy.md`](adr/0006-multi-tenancy-strategy.md),
[`adr/0013-row-level-security-with-non-owning-role.md`](adr/0013-row-level-security-with-non-owning-role.md)
and chapter 10 of the backend course. Summary:

- every functional table carries `organizationId`;
- the active organization travels in an `AsyncLocalStorage`, so it cannot be
  forgotten as a parameter;
- `TenantAwareRepository` injects it into every where clause and no repository
  method accepts it as an argument;
- writes use `updateMany`/`deleteMany` with the filter, never `update`/`delete`
  by primary key;
- the isolation suite performs the realistic attack — knowing the target's exact
  id — and requires it to fail;
- Row Level Security is the layer underneath: the API connects as `qaflow_app`,
  which owns nothing, so a query that forgets the tenant filter reads zero rows
  instead of everything. PostgreSQL exempts a table's owner from its own
  policies, which is why the role — not the policy — is what protects the data.
  The owner credential is used only by migrations, the seed and the test harness.

## Transport and headers

- Helmet: `X-Content-Type-Options`, `X-Frame-Options`, HSTS in production.
- CORS: explicit allow-list from `CORS_ORIGINS`, credentials enabled. A wildcard
  is accepted in development and **rejected at boot** in production, because a
  reflected origin plus credentials is the combination the allow-list exists to
  prevent.
- OpenAPI: `/docs` and `/docs/openapi.json` are unauthenticated, so they are
  disabled by default when `NODE_ENV=production` — the document is a complete map
  of the API, including every role-restricted route.
- Rate limiting: `@fastify/rate-limit`, in-memory. **Per instance** — see
  limitations.
- Request id: taken from `X-Request-Id` or generated, echoed back and attached
  to every log line and error response.

## Secrets

- Never in git. `.env.example` documents names and shapes, never values.
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be at least 32 characters;
  the application refuses to boot otherwise, in every environment.
- `IntegrationConnection` stores `secretRef`, a pointer into a secret manager,
  never a customer's API token. A database dump must not yield credentials for
  a customer's Jira.
- Logs never contain tokens, hashes or passwords. Failures log user ids.

## Known limitations

These are real and deliberate, not oversights. Also tracked in
[`technical-debt.md`](technical-debt.md).

1. **A refresh token still reaches non-browser clients in the response body.**
   Browsers get it as an `HttpOnly`, `SameSite=Strict` cookie scoped to
   `/api/v1/auth` and never see the value; a client that asks with
   `X-Refresh-Transport: body` gets it inline instead, which is what CI scripts
   and the integration suite use. The default is the safe one, but any script
   holding a 30-day credential in a variable is still a credential to protect.
2. **Rate limiting is per instance.** Two API replicas allow twice the
   configured rate. A shared store is the fix and it implies Redis, which is
   explicitly out of scope for now.
3. **No second factor and no SSO.** Both are expected by enterprise buyers.
4. **No password recovery**, because it requires real email delivery, which is
   out of scope for this version.
5. **Global tables have no RLS policy.** `users`, `sessions`, `organizations`,
   `organization_members` and `organization_invitations` are read before an
   active organization exists — login, listing your organizations, viewing an
   invitation — so a policy there could only be satisfied by disabling it on
   those paths. They are protected by the application layer only.
6. **Whoever holds the owner credential can rewrite history.** The append-only
   triggers stop the application and a `psql` session using the runtime role,
   not the table owner (`ALTER TABLE ... DISABLE TRIGGER`). The real answer is
   shipping audit records to an external append-only store.
7. **Attachments are metadata only.** No file is stored, so there is no upload
   surface to defend yet — and no antivirus scanning to design.
8. **Audit log records actions, not denials.** A burst of 403s is a useful
   signal we are not yet capturing.
