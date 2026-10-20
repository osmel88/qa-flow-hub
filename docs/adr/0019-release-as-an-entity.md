# 0019 — Release as a project entity linked to runs

Status: accepted
Date: 2026-11-15
Related: [0006](0006-multi-tenancy-strategy.md),
[0009](0009-test-case-snapshots-in-runs.md),
[0013](0013-row-level-security-with-non-owning-role.md),
[0017](0017-project-visibility-through-grants.md),
[0018](0018-api-keys-and-report-ingestion.md)

## Context

"What was verified before 2.4?" was answered through the free-text
`TestRun.milestone`. A typo created a second release, nothing stopped a run of
project A from claiming project B's label, and nobody could close a release so
that later runs stop counting. Auditors ask by release; CI knows the version it
builds.

## Options evaluated

| Option                                     | Cross-project safety           | Cost                                              |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------- |
| Keep `milestone`, add a lookup table       | None: still a string           | No migration of runs, but no lifecycle            |
| `Release` with a plain FK `releaseId → id` | Only in the service            | One table                                         |
| **`Release` with a composite FK**          | `(releaseId, projectId)` in DB | One table, one extra unique key `(id, projectId)` |

| Option for "closed"           | History                                         |
| ----------------------------- | ----------------------------------------------- |
| Delete or soft-delete         | Runs lose their release or point at a tombstone |
| **Status machine, no DELETE** | Runs, results and defects stay attached         |

## Decision

1. **`Release` belongs to one project**: `name`, `version` (unique per project,
   `[A-Za-z0-9][A-Za-z0-9._+-]{0,63}`), optional `tag`, `description`,
   `startDate`, `targetDate` (calendar days), and `releasedAt`/`archivedAt`.
2. **Status machine**: `planned → in_progress → released → archived`, with
   `planned|in_progress → archived` as shortcuts. `archived` is terminal and
   read-only. Runs can be attached only while the release is `planned` or
   `in_progress`.
3. **`TestRun.releaseId` is nullable and references `(id, projectId)`**, so a
   cross-project link fails in PostgreSQL even if a service forgot to check.
   `milestone` stays for labels that are not releases.
4. **Nothing is deleted.** `qaflow_app` has no `DELETE` on `releases`; the FK is
   `NO ACTION`. Archiving changes the status only.
5. **Locks**: a transition takes `FOR UPDATE` on the release; attaching a run
   (manual or CI) takes `FOR SHARE` in the same transaction as the write. A run
   is either attached before the release closes or refused with 409.
6. **Permissions**: `releases.read` (every role) and `releases.manage` (project
   manager and above), overridable per project. Attaching a run additionally
   needs `testruns.manage`, as any run edit does.
7. **CI**: `?release=<version>` on `/ingest/*` resolves the version inside the
   key's project; unknown, foreign or closed releases answer 404/409 and the
   ingestion writes nothing. With `runId`, the run must already be in that
   release.
8. **Dashboard**: `GET /releases/:id/summary` takes the latest executed result
   per case across the release's non-aborted runs; `GET /releases/:id/traceability`
   maps requirements → verifying cases → that result and run. Project analytics
   group runs by release entity next to the legacy milestone grouping.

## Consequences

- Moving a run between releases is allowed only while both are open.
- Releases inherit project visibility from services (ADR 0017); RLS still
  isolates organizations only (debt 39, unchanged).
- What this phase leaves is debt 41.
