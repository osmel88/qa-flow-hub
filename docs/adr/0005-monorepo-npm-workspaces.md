# 0005 — Monorepo with npm workspaces

Status: accepted
Date: 2026-07-31

## Context

The product is an API plus a web client that consume the same contracts:
pagination shape, error envelope, enums, and later the request/response schemas
of every endpoint. Those two artefacts are developed by the same people and
released together.

The failure mode we want to eliminate is **contract drift**: the API renames a
field, the client finds out in production.

## Options

**Two repositories, contracts published as an npm package.** Clean boundaries,
but every contract change becomes: change, publish, bump, install. In practice
people skip the ceremony and hand-copy types, which is exactly the drift we are
trying to prevent.

**Monorepo with npm workspaces.** Built into npm, no extra tooling. Workspace
packages are symlinked, so a contract change is visible immediately and breaks
the other side's build in the same commit.

**Monorepo with pnpm + Turborepo.** Faster installs, task graph with caching,
better at scale. Adds two tools to learn and maintain.

## Decision

Monorepo with npm workspaces, five packages: `apps/api`, `apps/web`,
`packages/shared`, `packages/ui`, `packages/config`.

With five packages, the build order fits in one line of `package.json` and the
onboarding instructions are `npm install`. Turborepo's caching solves a problem
we do not have yet.

## Consequences

**Good.** A change to `packages/shared` breaks the build of whichever side is
now inconsistent, in the same pull request. One TypeScript/ESLint/Prettier
configuration in `packages/config`, so "works on my machine" has one less cause.

**Bad.** `packages/shared` must be built before its consumers, and the build
order is maintained by hand in the root `build` script. It also has to be
published as **both ESM and CommonJS** (the API compiles to CommonJS, Vite
consumes ESM), which required a dual `tsc` run plus a script that writes the
`type` marker into each output directory — genuine complexity, documented in
`docs/backend-course/06-monorepo-structure.md`.

CI installs everything for every job, so pipeline time grows with the repository
rather than with the change.

**Cost of reversal.** Low. Migrating to pnpm + Turborepo later changes the
tooling configuration, not the application code.
