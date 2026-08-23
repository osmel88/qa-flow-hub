# Deployment

What it takes to run qa-flow-hub outside a laptop, what the current build already
gives you, and what a production deployment still needs. Nothing here is
aspirational: the parts that do not exist yet are marked as such and tracked in
[`technical-debt.md`](technical-debt.md).

## What the artefact is

One container image for the API (`apps/api/Dockerfile`, multi-stage, runtime stage
runs as `node` and ships only production dependencies plus compiled output), one
static bundle for the web client, and a PostgreSQL 16 database. There is no queue,
no Redis and no object storage, because nothing in the current feature set needs
them — see the roadmap for when that changes.

```
                        ┌──────────────┐
   browser ── HTTPS ───▶│ reverse proxy│──▶ static bundle (apps/web/dist)
                        │  TLS, gzip   │──▶ API container :3000
                        └──────────────┘          │
                                                  ▼
                                         PostgreSQL 16 (managed)
```

The API is stateless: sessions, refresh tokens and rate-limit-relevant state live
in PostgreSQL or in the user row, so replicas need no sticky sessions. The one
exception is the rate limiter, which is in-process — with N replicas the effective
limit is `max * N` (technical debt 1).

## The two database URLs are not optional

This is the deployment detail most likely to be got wrong, because both URLs
"work":

| Variable | Role | Used by |
| --- | --- | --- |
| `DATABASE_MIGRATION_URL` | table owner | `prisma migrate deploy`, seed, `db:grant-app-role` |
| `DATABASE_URL` | `qaflow_app`, owns nothing | the running API only |

PostgreSQL **exempts a table's owner from its own RLS policies**. Giving the API
the owner URL leaves every policy in place and every one of them bypassed: the
deployment looks correct and the defence is gone. Treat the owner credential like
a migration-time secret — available to the release job, not to the running
service.

## First deployment, in order

```bash
# 1. Schema, as the owner. Never `migrate dev` outside a laptop.
DATABASE_URL="$DATABASE_MIGRATION_URL" npx prisma migrate deploy \
  --schema apps/api/prisma/schema.prisma

# 2. Give the runtime role its password (creates nothing; it grants and sets it)
APP_DATABASE_PASSWORD="$APP_DATABASE_PASSWORD" \
  npm run db:grant-app-role -w @qa-flow-hub/api

# 3. Start the API with the runtime URL only
docker run --env-file ./prod.env -p 3000:3000 qa-flow-hub-api

# 4. Verify
curl -fsS https://api.example.com/health
```

Step 2 exists because the migration creates the role **without a password**: a
password inside a migration file is a committed secret, and it would be identical
in every environment that ever ran it.

## Required configuration

`.env.example` is the authoritative list. The ones with no safe default:

| Variable | Note |
| --- | --- |
| `DATABASE_URL` | `qaflow_app`, never the owner |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ≥ 32 chars, **different** from each other; the app refuses to boot otherwise |
| `CORS_ORIGINS` | explicit list; a wildcard **fails validation** when `NODE_ENV=production`, because CORS is registered with credentials |
| `WEB_BASE_URL` | invitation links are built from this, never from a request header |
| `NODE_ENV=production` | switches helmet to its default CSP and the refresh cookie to `Secure` |
| `SWAGGER_ENABLED` | off by default in production, because the schema is a map of the API. Set it to `true` only for a deployment that is not publicly reachable |

Rotating a JWT secret invalidates every token signed with it: access tokens die
within 15 minutes, refresh tokens immediately (their HMAC no longer matches), so a
rotation is a forced global logout. That is the intended behaviour after a
suspected leak; it is also why it should not be done casually on a Friday.

## Behind a proxy

The Fastify adapter runs with `trustProxy: true`, so `X-Forwarded-For` becomes the
client address used by the audit log and the rate limiter. That is only safe when
the app is **actually** behind a proxy that overwrites the header; exposed
directly, any client can claim any IP. Terminate TLS at the proxy, forward
`X-Request-Id` if you generate one there, and do not strip `Set-Cookie`.

The refresh cookie is scoped to `/api/v1/auth`, `HttpOnly`, `SameSite=Strict` and
`Secure` in production. If the API and the web client are on different sites
rather than different paths of the same one, `Strict` will drop the cookie on
cross-site navigations — serve both from one origin (proxy `/api` to the API), or
accept `Lax` and add CSRF protection. The current deployment assumes one origin.

## Zero-downtime releases

The API is stateless, so a rolling release works, with one constraint: during the
rollover, old and new code run against **one** schema. That makes migrations the
whole problem.

Safe (deploy in one step): adding a nullable column, adding a table, adding an
index (`CREATE INDEX CONCURRENTLY` for a large table), relaxing a constraint.

Needs two releases: a non-null column (add nullable → backfill in batches →
enforce), a rename (add new → write both → migrate reads → drop old), a type
change, dropping anything the previous version still reads.

Not exercised in this project yet — there is no production instance, and pretending
otherwise in a document would be the kind of claim this repository avoids. What
exists is the pattern above and the migration discipline: SQL files reviewed in
the PR, applied with `migrate deploy`, never edited after being applied.

## Backups and the thing backups do not cover

- Managed PostgreSQL point-in-time recovery is the baseline. **Verify a restore**;
  an untested backup is a belief.
- `audit_logs` is append-only through triggers, so a bug cannot rewrite history —
  but the owner credential can `ALTER TABLE ... DISABLE TRIGGER`. Whoever holds
  the migration credential can rewrite the audit trail. The honest fix is shipping
  audit records to an external append-only store; it is not implemented (technical
  debt 11's remainder).
- No retention policy: `audit_logs` grows forever, which is the correct default
  and eventually a cost problem (debt 19).

## Health, logs and what is missing

`GET /health` is unauthenticated and checks the database round trip; it is what the
container healthcheck and any load balancer should use. Logs are structured JSON
on stdout, each line carrying the `requestId` that also appears in error responses
and audit rows.

What a real production deployment still needs, and does not have:

1. **Metrics and alerting.** No `/metrics`, no p95 per endpoint, no alerts. Today
   an incident is noticed by a user.
2. **Error tracking.** Unexpected exceptions are logged with a stack trace and
   nothing aggregates them.
3. **Shared rate limiting.** Requires Redis (debt 1).
4. **Secret manager.** Secrets arrive as environment variables; `secretRef` in
   `IntegrationConnection` already assumes a manager that does not exist yet.
5. **Automated release pipeline.** CI builds, lints, tests and builds the image;
   nothing deploys.

## Local stack

```bash
docker compose up -d postgres postgres-test   # databases only, for development
docker compose up -d                          # plus API and web, production-ish
```

The test database is a separate service on port 5433 with a `tmpfs` volume:
disposable by definition, and truncation between suites is measurably faster.
Running the integration suite can never touch the data you are working with —
which is a deployment decision disguised as a developer convenience.

## Related

- [`../README.md`](../README.md) — quick start
- [`security-model.md`](security-model.md) — what the deployment must protect
- backend course, chapter 31 (Docker) and 32 (CI/CD)
