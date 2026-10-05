# Security model

What is implemented, what is deliberately not, and why. Claims here are backed
by tests in `apps/api/test/`; anything not implemented is listed as such rather
than described in the future tense.

## Threat model

| Threat                           | Control                                                                                                | Where                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Cross-tenant data access         | Row-level filter injected by the repository base, plus RLS policies enforced against a non-owning role | `tenant-aware.repository.ts`, `tenancy.int-spec.ts`, `rls.int-spec.ts`             |
| Rewriting the audit trail        | Append-only triggers on `audit_logs`; the API role cannot disable them                                 | `20260816135824_audit_log_append_only`, `dashboard.int-spec.ts`, `rls.int-spec.ts` |
| Credential stuffing              | Argon2id, per-account lockout, rate limiting                                                           | `password.service.ts`, `auth.service.ts`                                           |
| Account enumeration              | Identical error and identical timing                                                                   | `auth.service.ts` (`wasteTime()`)                                                  |
| Stolen refresh token             | Rotation with family revocation on reuse                                                               | `auth.service.ts`, `sessions.repository.ts`                                        |
| Stale authorization              | Session and membership checked per request                                                             | `jwt-auth.guard.ts`, `active-organization.guard.ts`                                |
| Mass assignment                  | Zod strips unknown keys                                                                                | `zod-validation.pipe.ts`                                                           |
| Injection                        | Parameterised queries via Prisma                                                                       | Repositories                                                                       |
| Information disclosure in errors | Single exception filter, no internals                                                                  | `all-exceptions.filter.ts`                                                         |
| Secrets in a database dump       | Password hashes, token HMACs, `secretRef` only                                                         | Schema                                                                             |

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
- Content Security Policy: the API answers JSON only, so its policy is
  `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  (helmet's default when Swagger is served). The web client gets its own
  policy from nginx (`apps/web/security-headers.conf`, mirrored in
  `vite preview` so the E2E suite runs under it): scripts from `'self'` only,
  API calls to the same origin, `blob:` images and frames for evidence
  previews, no framing.
- Rate limiting: `@fastify/rate-limit`, in-memory. A global per-address budget
  and a stricter one shared by `/auth/login`, `/auth/register` and
  `/auth/refresh`; 429 `RATE_LIMITED` with `Retry-After`. **Per instance** — see
  limitations.
- Client address: resolved from `X-Forwarded-For` only through `TRUST_PROXY`
  trusted hops, counted from the right, so a client cannot choose the address
  the rate limiter and the audit log see.
- Request id: an incoming `X-Request-Id` is kept only if it matches
  `[A-Za-z0-9._:-]{8,128}` (no log injection), otherwise generated; the same
  value is in the response header, the error body, every log line and the
  audit row.
- Errors: framework errors keep their real 4xx (400, 404, 413, 415, 429);
  anything unexpected is a generic 500 with the request id. No stack, SQL or
  infrastructure detail reaches a client.
- Probes and metrics: `/health` and `/health/ready` disclose statuses only;
  `/metrics` is off by default and token-protected, with no tenant or entity
  ids in labels.

## Secrets

- Never in git. `.env.example` documents names and shapes, never values.
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be at least 32 characters;
  the application refuses to boot otherwise, in every environment. In
  production they must also differ, contain no placeholder and have at least
  10 distinct characters; `METRICS_TOKEN` is held to the same rules.
- The API refuses to boot in production when its database role is a
  superuser, has `BYPASSRLS` or owns application tables: any of them would
  turn Row Level Security off without a single error.
- `IntegrationConnection` stores `secretRef`, a pointer into a secret manager,
  never a customer's API token. A database dump must not yield credentials for
  a customer's Jira. References resolve through the `SecretResolver` port,
  scoped to the caller's organization (ADR 0014); the environment provider
  only reads `QAFLOW_SECRET_<ORG>_*`, never the platform's own variables.
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
   configured rate. By decision (S2-F10) there is no shared store; the
   cluster-wide limit belongs to the edge (`docs/deployment.md`).
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
