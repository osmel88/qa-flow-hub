# 46 — Releases: an entity, a state machine and a composite foreign key

> Phase S3-F4. ADR 0019. Code: `apps/api/src/modules/releases`,
> `packages/shared/src/releases`, migration `20261115100000_releases`.

## 1. Why a string was not enough

`TestRun.milestone` is free text. It cannot be closed, cannot be listed, and
two projects can use the same label. A release is a thing with a lifecycle, so
it becomes a table — and the runs point at it.

## 2. Making cross-project links impossible in the database

A plain `releaseId → releases.id` FK only proves that the release exists, not
that it belongs to the run's project. The schema adds a second unique key on
`releases (id, projectId)` and makes the FK composite:

```sql
FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId")
```

Now `UPDATE test_runs SET "releaseId" = <release of another project>` fails
with a FK violation, whatever the service does. Cross-tenant links are already
impossible because RLS hides other organizations' releases (the FK check
itself bypasses RLS, but the release would also have to be in the same
project, which is in the same organization).

Exercise: in `psql` as the owner, try to point a run at a release of another
project and read the error.

## 3. The state machine lives in `shared`

`RELEASE_TRANSITIONS` is a plain record used by the API to refuse transitions
and by the web client to decide which buttons to show. One source of truth,
two consumers (ADR 0011).

## 4. Closing a release while CI attaches a run

Two transactions race: one archives the release, one attaches a run.

- `transition()` reads the status with `SELECT … FOR UPDATE`.
- `assertAttachable()` reads it with `SELECT … FOR SHARE` in the transaction
  that inserts or updates the run.

`FOR SHARE` conflicts with `FOR UPDATE`, so one of them waits. If the attach
commits first, the archive sees the run afterwards (and keeps it). If the
archive commits first, the attach re-reads `archived` and gets 409. The
regression in `releases.int-spec.ts` runs the race five times.

Why `FOR SHARE` and not `FOR UPDATE` for attaching? Many runs may be attached
concurrently to the same open release; they must not serialise each other,
only the status change.

## 5. Not losing history

Archiving is a status change. The runtime role has no `DELETE` on `releases`
and the FK is `NO ACTION`. The summary of an archived release is the same as it
was the day before it was archived.

## 6. "Latest result per case" across several runs

`caseStatuses()` uses `DISTINCT ON ("testCaseId")` ordered so that an executed
result beats `untested`, and a newer run beats an older one. A case that failed
in run 1 and passed in run 2 counts as passed; adding it to a third run that has
not executed it yet does not reset it to untested.

## 7. Dates without time zones

`startDate`/`targetDate` are `@db.Date`. The contract checks `YYYY-MM-DD` _and_
that the date round-trips: `Date.parse('2026-02-30')` silently returns March 2,
which the first version accepted.

## 8. What to read next

Debt 41 lists what this phase leaves open; debt 39 explains why project
visibility is still enforced in services and not in RLS.
