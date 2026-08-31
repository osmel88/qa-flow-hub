# 0004 — Prisma as the ORM

Status: accepted
Date: 2026-07-31

## Context

The API is TypeScript in strict mode and the data model has 21 entities. Two
properties matter more than raw query flexibility: the types must match the
tables (a renamed column should break compilation, not production), and schema
changes must arrive as reviewable, ordered migrations.

## Options

**TypeORM.** Decorator-based entities, familiar to anyone coming from Java or
.NET. Its migration story and its type inference have both been historically
unreliable, and the active-record/data-mapper duality invites inconsistency.

**Kysely / raw SQL.** Maximum control and excellent types. But every query is
hand-written, which for a CRUD-heavy product means a lot of code whose only
purpose is to be correct rather than interesting. No migration tooling included.

**Drizzle.** Close to SQL, good types, lighter than Prisma. Younger ecosystem;
less material to point a learning developer at.

**Prisma.** Schema-first, generated client with exact types, first-class
migrations, `$queryRaw` with typed results as an escape hatch.

## Decision

Prisma 6.

The schema-first model is what settles it: `schema.prisma` is a single readable
file that documents the entire data model, and the client is derived from it.
The team cannot drift from the database because the types come from the
database.

The escape hatch matters too. The traceability matrix and the dashboard
aggregates will eventually be hand-written SQL, and `$queryRaw` returns typed
rows rather than forcing us out of the type system.

## Consequences

**Good.** Types that cannot lie; migrations as reviewable SQL files; a readable
single-file description of the domain; `prisma studio` for inspecting data.

**Bad and worth knowing:**

- **The client is generated code and is not committed.** Nothing compiles until
  `prisma generate` has run — after cloning, after switching branches, and
  inside Docker unless `node_modules/.prisma` is copied out of the build stage.
  It is the most common "works on my machine" in this project.
- **`findUnique` cannot take arbitrary extra filters**, so tenant-scoped
  repositories use `findFirst` and `updateMany`. Not a limitation in practice,
  but it must be a known convention or somebody will write `update({ where: { id } })`
  and modify another organization's row.
- **Some SQL is not expressible in the schema language.** Four constraints in
  the initial migration are hand-written, including the partial unique index for
  pending invitations. `prisma db push` would erase them, so that command is
  never used in this project.
- **Complex aggregations are clumsier than SQL.** Expected; that is what
  `$queryRaw` is for.

**Cost of reversal.** Medium. Repositories are the only layer that touches
Prisma, so replacing it means rewriting repositories, not services.
