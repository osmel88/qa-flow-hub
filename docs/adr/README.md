# Architecture Decision Records

An ADR records **one** decision: the context that forced it, the options
considered, what was chosen and what it costs. It is written once and not
edited; if a decision is reversed, a new ADR supersedes the old one and the old
one is marked accordingly.

The point is not ceremony. Six months from now, someone (probably us) will ask
"why is this a modular monolith?" and the honest answer must be available
without archaeology through pull requests.

## Format

```
# NNNN — Title
Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Context      what forced a decision
## Options      what was actually considered
## Decision     what we chose
## Consequences what it costs us, including the bad parts
```

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-use-nestjs.md) | NestJS as the backend framework | accepted |
| [0002](0002-fastify-adapter.md) | Fastify adapter instead of Express | accepted |
| [0003](0003-postgresql.md) | PostgreSQL as the database | accepted |
| [0004](0004-prisma-orm.md) | Prisma as the ORM | accepted |
| [0005](0005-monorepo-npm-workspaces.md) | Monorepo with npm workspaces | accepted |
| [0006](0006-multi-tenancy-strategy.md) | Row-level multi-tenancy with a shared schema | accepted |
| [0007](0007-modular-monolith.md) | Modular monolith, not microservices | accepted |
| [0008](0008-jwt-and-refresh-tokens.md) | JWT access tokens with rotating refresh tokens | accepted |
