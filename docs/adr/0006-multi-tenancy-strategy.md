# 0006 — Row-level multi-tenancy with a shared schema

Status: accepted
Date: 2026-07-31

## Context

qa-flow-hub serves many customer organizations from one installation. A user can
belong to several organizations with a different role in each. The hard
requirement is absolute: no response may ever contain a row belonging to an
organization the caller is not a member of.

The product also wants self-service onboarding, which means creating a customer
must be cheap.

## Options

**Database per tenant.** Maximum isolation; a forgotten filter returns nothing
instead of somebody else's data. But N databases means N migrations, N backups,
N connection pools, and provisioning work for every signup. It also makes
cross-tenant analytics (our own product metrics) painful.

**Schema per tenant.** Middle ground. Still multiplies migration runs, and
PostgreSQL degrades with thousands of schemas.

**Row-level with a shared schema.** One database, `organizationId` on every
functional table. Creating a customer is an `INSERT`. Isolation becomes the
application's responsibility.

## Decision

Row-level with a shared schema, and `organizationId` denormalized onto **every**
functional table — including tables where it could be derived by joining
(`TestStep` could reach the organization through its case and project).

The denormalization is the part worth defending. It buys:

- a filter that is a single indexed predicate with no joins, so there are no
  joins to get wrong;
- a rule that can be verified by reading ("every query goes through `scope()`")
  rather than by reasoning about join paths;
- the option to enable PostgreSQL Row Level Security later without changing the
  data model.

Because the application now owns isolation, it is enforced in three layers and
proved by a fourth:

1. `ActiveOrgGuard` verifies membership and writes the organization into the
   request context;
2. the context travels in an `AsyncLocalStorage`, so it cannot be forgotten as a
   parameter;
3. `TenantAwareRepository` injects `organizationId` into every where clause, and
   no repository method accepts it as an argument;
4. `apps/api/test/tenancy.int-spec.ts` attempts the realistic attack — acting for
   organization A while knowing B's exact primary key — and requires it to fail.

Writes use `updateMany`/`deleteMany` with the tenant filter rather than
`update`/`delete` by primary key, which would happily modify another
organization's row.

## Consequences

**Good.** Onboarding a customer costs one row. One migration, one backup, one
pool. Product-wide analytics are a normal query.

**Bad.** A forgotten filter leaks data instead of returning nothing. That is the
single largest risk in the product and the reason for the layered enforcement
and the dedicated test suite. Raw SQL written outside the repository layer
bypasses all of it.

Denormalized `organizationId` can in principle disagree with the parent row's.
It cannot in practice, because the value is never supplied by the caller: the
repository stamps it from the request context.

**Escape hatch.** A regulated customer demanding physical separation can be
served by a dedicated deployment of the same code, with no schema change. That
is an operational cost, not a rewrite.
