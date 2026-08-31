# 0003 — PostgreSQL as the database

Status: accepted
Date: 2026-07-31

## Context

The domain is relational in the strict sense: the product's value *is* the links
between requirements, cases, runs, results and defects. The traceability matrix
is a multi-way join, and coverage gaps are anti-joins. On top of that, several
operations must be atomic across tables (creating a defect from a failed result
touches three), and multi-tenancy demands constraints that hold under
concurrency.

## Options

**MongoDB.** Flexible documents, easy to start. But the queries this product
exists to answer are joins, and enforcing "only one *pending* invitation per
organization and email" under concurrency requires transactional constraints
that a document store makes awkward.

**MySQL.** Perfectly capable. Weaker JSON support, no partial indexes, and a
less expressive type system.

**PostgreSQL.** Relational, strong transactional guarantees, `JSONB` with
indexing, partial indexes, check constraints, arrays and enums.

## Decision

PostgreSQL 16.

Three of its features are load-bearing here, not incidental:

- **Partial unique indexes.** `organization_invitations_pending_unique` allows
  exactly one pending invitation per organization and email while still
  permitting a re-invite after a revocation. A plain unique constraint cannot
  express that.
- **`JSONB`.** `TestRunCase.caseSnapshot` freezes a test case at inclusion time.
  Modelling it relationally would mean duplicating the case and step tables.
- **Check constraints.** Uppercase project keys, non-negative counters, and no
  self-referencing traceability links — invariants that no amount of application
  code can be trusted to enforce alone.

## Consequences

**Good.** Real transactions; constraints that hold regardless of application
bugs; the query shapes the product needs are natural; a clear path to Row Level
Security as defence in depth.

**Bad.** Schema changes require migrations, which is friction at prototype
speed. Vertical scaling limits will eventually appear; the mitigations
(read replicas, partitioning `test_results` by date) are known and not needed
yet.

**Operational cost.** One database to back up, monitor and upgrade. Managed
PostgreSQL is available from every provider, so this is not a lock-in decision.
