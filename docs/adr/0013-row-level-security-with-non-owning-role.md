# 0013 — Row Level Security enforced through a non-owning role

Status: accepted
Date: 2026-08-16
Extends: [0006](0006-multi-tenancy-strategy.md)

## Context

ADR 0006 chose a shared schema with an `organizationId` column on every functional
table, enforced by `TenantAwareRepository`: no repository method accepts the
organization as an argument, so it cannot be forgotten. The isolation suite proves
it works.

It still has one structural weakness: it is a *convention*. Any future code that
reaches Prisma without going through the base class — a raw query for a report, a
migration script, a hurried fix — has full cross-tenant access, and nothing fails.
In a product where one cross-tenant leak ends the company's credibility, "we always
remember" is not a control.

## Options

**Do nothing; rely on the repository and the tests.** Zero cost, and the failure
mode is silent and catastrophic.

**`FORCE ROW LEVEL SECURITY` with a single database credential.** No second
credential to manage, and the policies then apply to the table owner too — including
the seed and the test harness, several of which legitimately write across two
organizations to prove isolation. It would mean rewriting working isolation tests to
set a session variable by hand: more churn, equivalent guarantee.

**A non-owning application role.** Chosen.

## Decision

Two roles and two connection strings:

| Variable | Role | Used by |
| --- | --- | --- |
| `DATABASE_MIGRATION_URL` | table owner | migrations, seed, test harness |
| `DATABASE_URL` | `qaflow_app` (`SELECT/INSERT/UPDATE/DELETE` only) | the running API |

A `tenant_isolation` policy on every table carrying `organizationId`, with `USING`
**and** `WITH CHECK`, comparing against `current_setting('app.current_organization',
true)`. The variable is set with `set_config(..., TRUE)` **inside the same
transaction as the query**, through a Prisma client extension.

`TenantAwareRepository` remains the first layer. Its `prisma` getter returns the
extended client, so all repositories are covered without changing any of them — and
none of them can reach the unprotected client.

Two facts drive the shape of this decision:

- **PostgreSQL exempts a table's owner from its own policies.** So what protects the
  data is not `CREATE POLICY`, it is the role. With a single credential, RLS is
  decoration with a maintenance cost.
- **Transaction scope, never connection scope.** Prisma pools connections. Setting
  the variable per connection hands the previous request's organization to the next
  one: a leak *between* tenants with no error anywhere, which is worse than having no
  RLS at all. The policy, by contrast, fails closed — with no variable, `NULL`
  matches nothing and nothing is read.

## Consequences

**Good.** Defence in depth: a query that forgets the tenant filter now returns zero
rows instead of everything. `qaflow_app` also cannot disable the audit triggers or
drop a policy, which closes the remainder of ADR-adjacent debt 11. Rotating the
runtime password is one command plus a new `DATABASE_URL`.

**Bad.** A second credential to provision, store and rotate, and a deployment that
is wrong in a way that *looks* right if the owner URL is handed to the API. One extra
`set_config` statement per operation. Debugging changes too: reproducing a bug as the
owner can produce a false "it works".

**Deliberately not covered.** `users`, `sessions`, `organizations`,
`organization_members` and `organization_invitations` have no policy, because they
are read *before* an active organization exists — login, listing your organizations,
viewing an invitation. A policy there could only be satisfied by turning it off on
those paths, which is worse than not having it.

**Still open.** Whoever holds the owner credential can still rewrite history; the
real answer is an external append-only store for audit records.
