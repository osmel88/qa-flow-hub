# qa-flow-hub

QA management platform for software teams: organizations, projects,
requirements, test suites and cases, test runs, results, defects and full
traceability between all of them.

> Status: **work in progress**. This repository is being built phase by phase.
> Phase 0 (foundations) is in place: monorepo, API skeleton on NestJS + Fastify,
> web client on React + Vite, Docker stack and CI.

## Why this exists

Teams that manage QA in spreadsheets lose the link between *what was asked for*
(requirements), *what was verified* (test cases and runs) and *what broke*
(defects). qa-flow-hub keeps that chain intact and queryable, which is what makes
a release decision defensible.

Read [`docs/product-vision.md`](docs/product-vision.md) for the product angle
and [`docs/architecture.md`](docs/architecture.md) for the technical one.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 24 |
| API | NestJS 11 on the Fastify adapter, TypeScript in strict mode |
| Database | PostgreSQL 16 through Prisma |
| Contracts | Zod schemas shared between API and web (`packages/shared`) |
| Web | React 19, Vite, React Router, TanStack Query, React Hook Form |
| Tests | Vitest (unit + integration), Playwright (end to end) |
| Ops | Docker Compose, GitHub Actions |

Every choice is recorded with its trade-offs in [`docs/adr/`](docs/adr/).

## Repository layout

```
apps/api          NestJS API (modular monolith)
apps/web          React web client
packages/shared   Zod contracts, enums and types shared by API and web
packages/ui       Accessible presentational components
packages/config   Shared TypeScript, ESLint and Prettier configuration
docs              Product documentation, ADRs and the backend course
```

## Getting started

Requirements: Node.js 24 (`nvm use`), npm 11, Docker.

```bash
cp .env.example .env          # then replace the JWT secrets and APP_DATABASE_PASSWORD
npm install
docker compose up -d postgres postgres-test
npm run db:migrate            # as the owner, via DATABASE_MIGRATION_URL
npm run db:grant-app-role -w @qa-flow-hub/api   # password for the runtime role
npm run db:seed
npm run dev                   # API on :3000, web on :5173
```

There are **two** database connections, and the split is what makes Row Level
Security real: `DATABASE_MIGRATION_URL` is the owner and is used by migrations,
the seed and the test harness, while `DATABASE_URL` is the `qaflow_app` role the
running API uses — it owns no table, so the tenant policies apply to it. Never
give the API the owner URL. See `docs/technical-debt.md` entry 5.

The whole stack can also run in containers:

```bash
docker compose up -d --build  # web on :8080, API on :3000, OpenAPI on :3000/docs
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web client in watch mode |
| `npm run build` | Builds every workspace in dependency order |
| `npm run lint` | ESLint across the monorepo |
| `npm run typecheck` | `tsc --noEmit` per workspace |
| `npm run test` | Unit tests (API + web + shared) |
| `npm run test:integration` | API integration tests against a real PostgreSQL |
| `npm run test:e2e` | Playwright end-to-end test of the main flow |
| `npm run db:migrate` | Applies migrations (owner connection) |
| `npm run db:grant-app-role -w @qa-flow-hub/api` | Sets the runtime role's password from `APP_DATABASE_PASSWORD` |
| `npm run db:seed` | Loads fictional demo data |
| `npm run db:reset` | Drops, recreates, migrates and seeds |

## Documentation

- [`docs/`](docs/) — product and engineering documents:
  [product vision](docs/product-vision.md), [architecture](docs/architecture.md),
  [domain model](docs/domain-model.md), [traceability model](docs/traceability-model.md),
  [security model](docs/security-model.md), [permissions matrix](docs/permissions-matrix.md),
  [API conventions](docs/api-conventions.md), [frontend architecture](docs/frontend-architecture.md),
  [deployment](docs/deployment.md), [commercial roadmap](docs/commercial-roadmap.md),
  [integrations roadmap](docs/integrations-roadmap.md),
  [stage 2 roadmap](docs/stage-2-roadmap.md) and
  [technical debt](docs/technical-debt.md).
- [`docs/backend-course/`](docs/backend-course/) — a 40-chapter guided tour of
  this backend, written against the real code in this repository. Start at
  [`00-how-to-use-this-course.md`](docs/backend-course/00-how-to-use-this-course.md).

## Security

No real credentials live in this repository. `.env` is git-ignored and
`.env.example` documents every variable. Multi-tenant isolation, authorization
and the threat model are described in
[`docs/security-model.md`](docs/security-model.md).
