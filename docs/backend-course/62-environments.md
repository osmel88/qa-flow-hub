# 62 — Environments: migrating in place, archiving and protection

Phase S6-F1. Code: `apps/api/src/modules/development/environments.service.ts`,
`packages/shared/src/development/environment.contracts.ts`. Builds on
chapter 61.

## 1. Grow the table, don't replace it

S5-F5 created a minimal `environments` table that deployments already point
to. Replacing it would mean moving foreign keys; instead the migration adds
columns with safe defaults, rewrites the old kinds and only then adds the
new CHECKs. The backfill sits between `-- backfill:start` and
`-- backfill:end`, so an integration test can replay exactly those
statements on legacy rows inside a transaction it rolls back.

## 2. History forbids deletion

A deployment row keeps a `RESTRICT` foreign key to its environment, so the
database would refuse the delete anyway; the service answers with a clear
409 and points to archiving. Archiving takes the row `FOR UPDATE`, and
recording a deployment takes it `FOR SHARE`, so the two never interleave.

## 3. Protection is a permission, checked under the lock

Whether an environment is protected is read while it is locked, so
unprotecting it and deploying to it cannot race. The check lives in the
service, not the guard, because the guard does not know the environment.

## 4. Health is derived

Health comes from the newest deployments every time it is read; nothing is
stored that could go stale.

## Exercises

1. Add a deployment window during which protected environments refuse
   deployments.
2. Move the `health` filter into SQL.
