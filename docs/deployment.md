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

| Variable                 | Role                       | Used by                                            |
| ------------------------ | -------------------------- | -------------------------------------------------- |
| `DATABASE_MIGRATION_URL` | table owner                | `prisma migrate deploy`, seed, `db:grant-app-role` |
| `DATABASE_URL`           | `qaflow_app`, owns nothing | the running API only                               |

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
curl -fsS https://api.example.com/health        # liveness: the process answers
curl -fsS https://api.example.com/health/ready  # readiness: DB, migrations, storage, RLS role
```

Step 2 exists because the migration creates the role **without a password**: a
password inside a migration file is a committed secret, and it would be identical
in every environment that ever ran it.

## Required configuration

`.env.example` is the authoritative list. With `NODE_ENV=production` the API
**fails closed**: it refuses to boot rather than run with a configuration that
is merely unusual in development.

| Variable                                  | Production rule                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | `qaflow_app`, never the owner. At boot the API inspects its own role and **exits** if it is a superuser, has `BYPASSRLS`, owns application tables (directly or as a member of the owning role) or is a member of a superuser/`BYPASSRLS` role — each silently disables Row Level Security |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ≥ 32 chars everywhere; in production also **different** from each other, free of placeholders (`replace-me`, `replace-with`, `change-me`, …) and with at least 10 distinct characters                                                                                                     |
| `CORS_ORIGINS`                            | explicit list; a wildcard fails validation, also inside a list (`https://a.example,*`), because CORS is registered with credentials                                                                                                                                                       |
| `STORAGE_PROVIDER`                        | `local` (or a future S3 provider); `memory` is refused — evidence would vanish on restart                                                                                                                                                                                                 |
| `STORAGE_LOCAL_ROOT`                      | a persistent volume, backed up with the database                                                                                                                                                                                                                                          |
| `TRUST_PROXY`                             | the exact number of proxies in front of the API (see below)                                                                                                                                                                                                                               |
| `METRICS_ENABLED`, `METRICS_TOKEN`        | metrics off by default; when on, the token is required and held to the secret rules                                                                                                                                                                                                       |
| `LOG_FORMAT`                              | `json` by default in production                                                                                                                                                                                                                                                           |
| `WEB_BASE_URL`                            | invitation links are built from this, never from a request header                                                                                                                                                                                                                         |
| `SWAGGER_ENABLED`                         | off by default in production, because the schema is a map of the API. Set it to `true` only for a deployment that is not publicly reachable                                                                                                                                               |

Rotating a JWT secret invalidates every token signed with it: access tokens die
within 15 minutes, refresh tokens immediately (their HMAC no longer matches), so a
rotation is a forced global logout. That is the intended behaviour after a
suspected leak; it is also why it should not be done casually on a Friday.

Integration credentials are not environment configuration: they live in an
external secret manager reached through the `SecretResolver` port
([ADR 0014](adr/0014-external-secret-manager.md)). Until GitHub Real chooses
the manager, the only provider reads `QAFLOW_SECRET_<ORG>_<NAME>` variables,
for alphanumeric organization ids only (an id containing `_` or `-` could claim
another organization's variables).

## Behind a proxy

`TRUST_PROXY` is the number of proxies that append to `X-Forwarded-For` in
front of the API. The client address is the entry that many hops from the
**right** of the header — the one the outermost trusted proxy wrote — and
everything to its left, which the client controls, is ignored. Fastify's
`request.ip` (the rate limiter's key) and the audit log's `ipAddress` use the
same rule (`resolveClientIp`).

| Topology                           | `TRUST_PROXY`               |
| ---------------------------------- | --------------------------- |
| API reached directly               | `0` — the header is ignored |
| nginx → API (`docker-compose.yml`) | `1`                         |
| CDN → load balancer → API          | `2`                         |

A value higher than reality lets any client choose its own address — and with
it, its rate-limit bucket and what the audit log says. That is why the compose
stack publishes the API port on loopback only.

`X-Request-Id`: an incoming value of 8–128 characters from `[A-Za-z0-9._:-]`
is kept (nginx forwards its `$request_id`); anything else is replaced by a
UUID. The same id is in the response header, the error body, every log line of
the request and the audit row.

The refresh cookie is scoped to `/api/v1/auth`, `HttpOnly`, `SameSite=Strict` and
`Secure` in production. If the API and the web client are on different sites
rather than different paths of the same one, `Strict` will drop the cookie on
cross-site navigations — serve both from one origin (proxy `/api` to the API), or
accept `Lax` and add CSRF protection. The current deployment assumes one origin.

## Rate limiting

`@fastify/rate-limit` with an in-memory store (`SnapshotRateLimitStore`: the
plugin's default store rejected a whole concurrent burst once it exceeded the
budget, instead of only the excess), so the limits are **per instance**: with N replicas the effective limit is N times the configured one.
That is the approved trade-off (no Redis); the cluster-wide limit is the
edge's job.

| Budget                                                                      | Key                      | Default             | Variables                                          |
| --------------------------------------------------------------------------- | ------------------------ | ------------------- | -------------------------------------------------- |
| Global                                                                      | client address           | 300 / minute        | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`           |
| Credentials: `POST /auth/login`, `/auth/register`, `/auth/refresh` (shared) | `auth:` + client address | 20 / minute         | `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` |
| Account lockout (independent)                                               | account                  | 5 failures → 15 min | `AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES` |

`/health` and `/health/ready` are never limited. A limited request gets
`429 { "error": { "code": "RATE_LIMITED", ... } }` and `Retry-After`.

**At the edge**, configure a limit that does not depend on the replica count,
for example with nginx:

```nginx
limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;
location ~ ^/api/v1/auth/(login|register|refresh)$ {
  limit_req zone=auth burst=10 nodelay;
  proxy_pass http://api:3000;
}
```

or the equivalent rule in the CDN or load balancer (Cloudflare rate limiting
rules, AWS WAF rate-based rules). Keep the per-instance limits on as well:
they protect an instance from a neighbour that bypasses the edge.

## Zero-downtime releases

The API is stateless, so a rolling release works, with one constraint: during the
rollover, old and new code run against **one** schema. That makes migrations the
whole problem.

Safe (deploy in one step): adding a nullable column, adding a table, adding an
index (`CREATE INDEX CONCURRENTLY` for a large table), relaxing a constraint.

Needs two releases: a non-null column (add nullable → backfill in batches →
enforce), a rename (add new → write both → migrate reads → drop old), a type
change, dropping anything the previous version still reads.

Before every deployment:

```bash
npm run db:migrations:check                       # static review, no database (also in CI)
DATABASE_URL=$DATABASE_MIGRATION_URL \
  npm run db:migrations:status -w @qa-flow-hub/api  # what this database has applied
```

`db:migrations:check` refuses, in any migration newer than the reviewed
history, `DROP TABLE|COLUMN|SCHEMA|TYPE`, `TRUNCATE`, renames, column type
changes, `SET NOT NULL`, `DELETE` without `WHERE`, and anything that weakens
RLS (`DISABLE`/`NO FORCE ROW LEVEL SECURITY`, `DROP POLICY`, `BYPASSRLS`). An
intended contract step is accepted with an explicit marker and a reason:

```sql
-- migration-safety: allow drop-column: unread since release 1.4 (expand/contract step 3)
ALTER TABLE "projects" DROP COLUMN "legacy_code";
```

Applied migrations are never edited (their checksum is recorded); the list of
reviewed ones is `REVIEWED_HISTORY` in `apps/api/prisma/check-migrations.ts`,
appended by the release that ships a new migration.

At runtime, `/health/ready` fails while any migration shipped with the code is
missing or failed in the database, so a new release never takes traffic on an
old schema.

Graceful shutdown: on `SIGTERM` the instance starts answering `503 draining`
on `/health/ready`, waits `SHUTDOWN_GRACE_MS` (default 5 s) so the load
balancer notices, then stops accepting connections, finishes in-flight requests
and closes the database pool. The orchestrator's grace period
(`stop_grace_period`, `terminationGracePeriodSeconds`) must be longer.

## Backup, restore and disaster recovery

Targets for the first production deployment (to be confirmed with the
hosting choice):

|                               | Target                                                                 | How                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **RPO** (data you may lose)   | ≤ 5 min with managed PITR; ≤ 24 h with nightly dumps only              | WAL archiving / provider PITR; `scripts/db-backup.sh` nightly as the independent copy |
| **RTO** (time to serve again) | ≤ 1 h                                                                  | restore runbook below; the drill measures it                                          |
| **Retention**                 | 14 daily dumps (`RETENTION_DAYS`), PITR window per provider (≥ 7 days) | the backup script prunes; copy dumps off the host                                     |

### Backups

```bash
DATABASE_MIGRATION_URL=postgresql://owner:...@db:5432/qa_flow_hub \
  scripts/db-backup.sh /backups
```

- Runs as the **owner**. The runtime role is under RLS: its dump would contain
  no tenant rows at all.
- `pg_dump -Fc`, verified with `pg_restore --list`, with a `.sha256` next to it.
  Uses the host's `pg_dump`, or the `postgres:16-alpine` image through Docker.
- Roles are cluster-wide and **not** in the dump. A new server needs
  `qaflow_app` recreated (the RLS migration's `CREATE ROLE`, then
  `db:grant-app-role`) before the API can connect.
- **Evidence files are not in the database.** Back up `STORAGE_LOCAL_ROOT`
  (the `api-storage` volume) in the same window, e.g.
  `docker run --rm -v qa-flow-hub_api-storage:/data -v "$PWD":/out alpine tar czf /out/storage-$(date -u +%F).tgz -C /data .`.
  Rows without objects degrade to a 404 on download; objects without rows are
  invisible. Restore both from the same window.
- Encrypt and copy backups off the database host; a backup next to the disk
  it protects is not a backup.

### Restore drill

```bash
DATABASE_MIGRATION_URL=... scripts/restore-drill.sh [dump]
```

Restores the latest (or given) dump into `<db>_restore_drill` on the same
server and fails unless: the checksum matches, every migration in the
repository is applied, Row Level Security covers the same tables with the same
policies as the source, and `qaflow_app` exists with its grants. It prints row
counts and the elapsed time (your RTO baseline), then drops the scratch
database. Run it monthly and after every PostgreSQL upgrade.

### Restore runbook

1. Declare the incident; stop writes (scale the API to 0 or put the edge in
   maintenance) so nothing writes into a database you are about to replace.
2. Choose the point: PITR timestamp just before the incident, or the latest
   verified dump.
3. Restore into a **new** database (provider PITR, or `createdb` +
   `pg_restore --exit-on-error` as the owner). Never restore over the damaged one;
   it is evidence.
4. Ensure `qaflow_app` exists and run `npm run db:grant-app-role -w @qa-flow-hub/api`
   against it, then `npm run db:migrations:status` — the code you are about to
   start may need migrations the backup predates (`migrate deploy`).
5. Restore evidence files from the same window.
6. Point `DATABASE_URL` (runtime role) and `DATABASE_MIGRATION_URL` (owner) at it;
   start one instance; wait for `/health/ready` 200 — it proves the role is not
   the owner, migrations are applied and storage is writable.
7. Smoke test (log in, open a project, download one attachment), then scale out
   and lift maintenance. Record the actual RPO/RTO in the incident report.

RLS survives a restore because policies are part of the schema — provided the
restore runs as the owner and the API keeps connecting as `qaflow_app`. Pointing
the API at the owner "to get it working" is exactly what the boot-time role
check refuses.

### What backups do not cover

- `audit_logs` is append-only through triggers, so a bug cannot rewrite history —
  but the owner credential can `ALTER TABLE ... DISABLE TRIGGER`. Whoever holds
  the migration credential can rewrite the audit trail. The honest fix is shipping
  audit records to an external append-only store; it is not implemented (technical
  debt 11's remainder).
- No retention policy: `audit_logs` grows forever, which is the correct default
  and eventually a cost problem (debt 19).

## Health, logs and metrics

| Endpoint            | Meaning                                 | Checks                                                                                                                                                                                                                        | Use for                                          |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /health`       | **liveness** — the process answers      | none (no database)                                                                                                                                                                                                            | restart decisions                                |
| `GET /health/ready` | **readiness** — this instance can serve | `SELECT 1`; every migration on disk applied and none failed; a probe object written to and deleted from storage; the runtime role is not superuser/`BYPASSRLS`/owner; not draining. Concurrent probes share one running check | load balancer, compose healthcheck, deploy gates |

Readiness answers `200 {"status":"ready","checks":{...}}` or `503` with
`not_ready` / `draining`. Each check reports `ok`, `warn` (role check outside
production, where the integration suites connect as the owner) or `fail`, and
a duration — never an error message, host name, URL or path. Both probes are
unauthenticated, outside `/api`, and never rate limited.

**Logs** are JSON on stdout in production (`LOG_FORMAT`), one object per line:
`time`, `level`, `context`, `msg`, `requestId` and fields. One `request completed`
line per request carries `method`, the **route template** (`/api/v1/projects/:id`,
never the concrete URL or query string), `statusCode` and `durationMs`. Headers
and bodies are never logged, and keys matching
`authorization|cookie|password|secret|token|credential` are redacted at any
depth. Probe requests log at `debug`. Unexpected errors log their stack with the
request id; the client gets a generic 500.

**Metrics**: `GET /metrics`, Prometheus text format, off unless
`METRICS_ENABLED=true`, protected by `Authorization: Bearer $METRICS_TOKEN`
(mandatory in production). Series:

- `http_requests_total{method,route,status}`
- `http_request_duration_seconds{method,route}` (histogram, 5 ms – 10 s)
- `process_uptime_seconds`, `process_resident_memory_bytes`, `nodejs_heap_used_bytes`

Labels never contain a tenant, user, project or entity id; unmatched URLs are
`route="unmatched"` and unknown methods `OTHER`, so the series count is bounded
by the route table. Scrape each instance; aggregate in Prometheus.

What a real production deployment still needs, and does not have:

1. **Alerting and dashboards** on top of the metrics (error rate, p95, 429 rate,
   readiness flaps).
2. **Error tracking.** Unexpected exceptions are logged with a stack trace and
   nothing aggregates them.
3. **A concrete secret manager** (ADR 0014; with GitHub Real).
4. **Automated release pipeline.** CI builds, lints, tests, reviews migrations
   and builds the images; nothing deploys.

## Local stack

```bash
docker compose up -d postgres postgres-test   # databases only, for development
docker compose up -d                          # plus API and web, production-ish
```

The production-ish stack runs the API with `NODE_ENV=production`, so it needs
real secrets in `.env` (the `.env.example` placeholders are refused), keeps
evidence in the `api-storage` volume, trusts one proxy hop (nginx), publishes
the API on `127.0.0.1:3000` only, and reports healthy on `/health/ready`.
nginx adds the web security headers (`apps/web/security-headers.conf`: CSP,
`nosniff`, `DENY` framing, referrer and permissions policies); `vite preview`
sends the same headers so the end-to-end suite runs under the production CSP.

The test database is a separate service on port 5433 with a `tmpfs` volume:
disposable by definition, and truncation between suites is measurably faster.
Running the integration suite can never touch the data you are working with —
which is a deployment decision disguised as a developer convenience.

## Billing

| Variable                         | Default                  | Production rule                                         |
| -------------------------------- | ------------------------ | ------------------------------------------------------- |
| `BILLING_PROVIDER`               | `mock`                   | `mock` is refused at boot: a real provider is required. |
| `BILLING_WEBHOOK_SECRET`         | development-only value   | ≥ 32 characters, not weak, placeholder or the default.  |
| `BILLING_TRIAL_DAYS`             | `14`                     | —                                                       |
| `BILLING_PAST_DUE_GRACE_DAYS`    | `7`                      | —                                                       |
| `BILLING_WEBHOOK_RATE_LIMIT_MAX` | `120` per window, per IP | Allow-list the provider's IPs at the edge if possible.  |

## Import and export

| Variable                | Default           | Notes                                                                  |
| ----------------------- | ----------------- | ---------------------------------------------------------------------- |
| `IMPORT_MAX_BYTES`      | `5242880` (5 MiB) | Checked before parsing; the file is held in memory, never stored.      |
| `IMPORT_MAX_ROWS`       | `20000`           | Data rows per file.                                                    |
| `IMPORT_MAX_CASES`      | `5000`            | Distinct cases per file.                                               |
| `IMPORT_JOB_TTL_HOURS`  | `24`              | A dry run left uncommitted expires and loses its stored plan.          |
| `IMPORT_TX_TIMEOUT_MS`  | `60000`           | Upper bound of the commit transaction (it holds a per-project lock).   |
| `IMPORT_RATE_LIMIT_MAX` | `10` per window   | Per client IP, on dry runs and commits; per instance like every limit. |
| `EXPORT_MAX_ROWS`       | `100000`          | A larger export is refused with 422; the body is built in memory.      |

## API keys and report ingestion

| Variable                          | Default           | Notes                                                      |
| --------------------------------- | ----------------- | ---------------------------------------------------------- |
| `INGEST_MAX_BYTES`                | `5242880` (5 MiB) | Multipart limit for `POST /api/v1/ingest/*`; 413 above it. |
| `INGEST_MAX_TESTS`                | `10000`           | Test entries per report; 413 above it.                     |
| `INGEST_TX_TIMEOUT_MS`            | `60000`           | Upper bound of the transaction that records one report.    |
| `INGEST_RATE_LIMIT_MAX`           | `30` per window   | Per API key prefix (per IP without a well-formed key).     |
| `API_KEYS_MAX_ACTIVE_PER_PROJECT` | `25`              | Creating one more active key answers 409.                  |

CI uploads with `curl -H "Authorization: Bearer $QAFLOW_API_KEY" -F
file=@junit.xml "$API/api/v1/ingest/junit?runName=CI%20$BUILD"`; add
`-H "Idempotency-Key: $BUILD_ID"` to make retries safe.

Size the reverse proxy's `client_max_body_size` to at least `IMPORT_MAX_BYTES`
plus multipart overhead, or the proxy answers 413 before the API can explain.

The webhook endpoint is `POST /api/v1/billing/webhooks/<provider>`. It must be
reachable from the provider without authentication; the proxy must forward
the body unmodified (the signature covers the raw bytes) and must not buffer
bodies above 64 KiB for it. No background job is needed: trial and grace
expiry are evaluated on read. See ADR 0015.

## Related

- [`../README.md`](../README.md) — quick start
- [`security-model.md`](security-model.md) — what the deployment must protect
- backend course, chapter 31 (Docker) and 32 (CI/CD)
