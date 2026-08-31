# 0010 — One polymorphic table for traceability links

Status: accepted
Date: 2026-08-16

## Context

Traceability is the product, and it is not one relationship: requirement→case,
defect→requirement, defect→case, case→automated test, and more to come (release,
risk, review). The links are also asymmetric in cardinality and in meaning, and the
set of linkable types is expected to grow with every feature.

The matrix query must stay a small, fixed number of queries no matter how many link
types exist.

## Options

**A join table per pair.** `requirement_test_cases`, `defect_requirements`, … Real
foreign keys, real cascades, the database enforces integrity. Every new pair is a
migration, a repository, and another branch in the matrix query, which grows with
the feature set.

**A `links` table with nullable columns per type.** `requirementId`, `testCaseId`,
`defectId`, all nullable, plus a check constraint. Keeps foreign keys, and turns
every new type into a schema change with an ever-wider table and a check constraint
nobody can read.

**One polymorphic table.** Chosen: `sourceType`, `sourceId`, `targetType`,
`targetId`, `linkType`, `organizationId`.

## Decision

One table, `traceability_links`, with the entity type stored as an enum
(`LinkableEntity`) and the id as a plain string. Adding a link type adds **rows and
an enum value**, not columns, and the matrix keeps its shape.

Integrity, which the database can no longer enforce, is enforced in three places
instead, and each is tested:

1. On create, both ends must resolve to a **live** entity in the caller's
   organization, and the caller must be allowed in that end's project.
2. On soft delete of either end, the links are purged in the same transaction, in
   both directions.
3. On read, an unresolvable end is skipped rather than guessed.

## Consequences

**Good.** New link types are cheap. The matrix is four queries regardless. A single
place holds the tenant filter, the audit trail and the purge logic.

**Bad, and the reason this ADR exists.** **No foreign keys.** PostgreSQL will accept
a row pointing at nothing, so a direct SQL write — or a code path that forgets rule
2 — can create an orphan that the database would have refused in the per-pair
design. That is a real loss of a real guarantee, traded for a schema that does not
grow with the feature set. Tracked as technical debt 14; the trigger for revisiting
is a periodic integrity job, or evidence of an orphan in practice.

**Also bad.** `sourceId`/`targetId` cannot be joined by the query planner as a
foreign key, so the matrix does its grouping in application memory. With tens of
thousands of requirements the report itself needs pagination (debt 14 and 17).

**Neutral but worth knowing.** Because the type is an enum, a *typo* is impossible —
which removes the most common failure mode of polymorphic designs in dynamically
typed systems.
