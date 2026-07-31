# 0007 — Modular monolith, not microservices

Status: accepted
Date: 2026-07-31

## Context

The product has a dozen functional areas: organizations, projects, requirements,
test design, execution, defects, traceability, audit, integrations. It is built
by a very small team and has no users yet. Several operations span areas and
must be atomic — creating a defect from a failed result writes to `defects`,
touches `test_results` and increments a counter on `projects`.

## Options

**Microservices.** Independent deployment and scaling per area, enforced
boundaries. In exchange: distributed transactions (or sagas) for the operations
above, network failure modes between every pair of services, N pipelines, N
deployments, distributed tracing as a prerequisite rather than a nicety, and no
foreign keys across service boundaries.

**Unstructured monolith.** Fast at first, then every module imports every other
module and the boundaries stop existing.

**Modular monolith.** One deployable, internally divided into modules with
explicit rules about how they may talk to each other.

## Decision

Modular monolith. One NestJS application, one PostgreSQL database, one
deployment.

The boundaries are real, enforced by convention and review:

1. A module never imports another module's **repository**; it imports the module
   and uses its exported **service**.
2. A service never touches `PrismaClient` directly; it goes through a repository
   that carries the tenant filter.
3. Side effects that are not part of the caller's transaction go through the
   in-process event bus, so they already look like the asynchronous messages
   they would become.
4. Modules are registered only in `AppModule`, so the dependency graph is
   readable in one file.

Point 3 is the extraction plan: a module whose interaction with the rest is
already events and a service interface can become a separate deployable without
redesigning it.

## Consequences

**Good.** One transaction boundary, so cross-area atomicity is a `BEGIN`.
Foreign keys work. One pipeline, one deployment, one log stream. Refactoring
across modules is a compiler-checked rename.

**Bad.** Everything scales together: a heavy traceability query competes with
login requests in the same process. A module cannot choose a different runtime
or release cadence. And boundaries enforced by convention *can* be violated —
the mitigation is that violations are visible in review, and the two rules above
are short enough to remember.

**Trigger to revisit.** A specific area with a genuinely different scaling
profile (most likely automated-result ingestion from CI, which is bursty and
write-heavy) or a team large enough that deployment coordination becomes the
bottleneck. Neither is true today, and building for either now would be paying
the cost of a solution to a problem we do not have.
