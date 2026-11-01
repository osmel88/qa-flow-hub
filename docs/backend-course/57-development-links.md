# 57 — Development links: one table for five kinds and a port for providers

Phase S5-F1. Code: `apps/api/src/modules/development/`,
`packages/shared/src/development/development.contracts.ts`,
`apps/web/src/pages/DevelopmentPage.tsx` and the migration
`20270117100000_development_links`. Builds on chapter 53 (requirement links),
whose link/unlink pattern it reuses. Decision record: ADR 0025.

## 1. One table, five kinds

Branches, commits, pull requests, builds and deployments share almost
everything: a project, a provider, an optional external id and URL, a status,
links to work items, permissions and soft delete. They differ in one
reference field each. So `development_artifacts` has a `kind` and the
reference columns of every kind, and the database enforces which one must be
set:

```sql
CHECK (
  ("kind" = 'branch' AND "branchName" IS NOT NULL)
  OR ("kind" = 'commit' AND "commitSha" IS NOT NULL)
  OR ...
)
```

A second CHECK restricts `status` per kind, mirrored by
`DEVELOPMENT_STATUSES` in the shared contracts so the API answers 400 before
the database would refuse.

## 2. Duplicates without a race

`naturalKeyOf()` turns the reference into one string (branch name, lowercase
SHA, `#42`, identifier). A partial unique index makes it unique among live
rows:

```sql
CREATE UNIQUE INDEX ... ("projectId", "provider", "kind", "naturalKey")
  WHERE "deletedAt" IS NULL;
```

Two concurrent creations of the same pull request both pass validation; the
second insert waits on the index and fails with `P2002`, which the service
maps to 409 `DUPLICATE_RESOURCE`. Because the index ignores deleted rows, a
deleted artifact can be recorded again, and the old row stays as history.

## 3. Links: idempotent, locked, project-checked twice

Linking follows chapter 53: lock the artifact `FOR SHARE`, authorize its
project, lock the work item `FOR SHARE`, compare projects, then
`createMany({ skipDuplicates: true })`. Deleting an artifact takes
`FOR UPDATE`, so it waits for a link in flight (or the link sees it deleted
and answers 404). The composite foreign keys `(workItemId, projectId)` and
`(artifactId, projectId)` are the second check: even a bug in the service
cannot store a cross-project link.

## 4. A port for providers

`DevelopmentActivitySource` is an interface with no implementation. A future
GitHub adapter will map webhooks to `DevelopmentActivityRecord`s and call the
service with `provider: 'github'` and an `externalId`; the second partial
unique index on `(project, provider, kind, externalId)` makes that upsert
safe. The domain module imports no SDK, which is what keeps "local/mock
first" honest.

## Exercises

1. Detect work item keys in branch names and link them automatically.
2. Implement a mock `DevelopmentActivitySource` and a sync endpoint that
   upserts by `externalId`.
3. Show the development activity of a release by joining its work items.
