# 58 — A derived status: precedence, determinism and auditing what is not stored

Phase S5-F2. Code: `computeDevelopmentStatus()` in
`packages/shared/src/development/development.contracts.ts`,
`DevelopmentService.statusesOf/filterFor/auditStatusChanges` and the
callers in work items, boards and Kanban. Builds on chapter 57.

## 1. Derive, do not store

The status of a work item is a function of its live linked artifacts. Storing
it would create a second source of truth that every link, edit, delete and
future provider sync must keep in step. Deriving it on read costs one query
per list (`signals()` loads kind, status and time of the linked artifacts)
and can never disagree with the links.

## 2. Precedence and determinism

The statuses are listed from lowest to highest precedence; the function
checks them from the top: succeeded deployment, the latest build that ran,
merged/approved/open pull requests, commits, branches. "Latest" is defined
by `occurredAt`, then creation time, then id, so two queries returning the
links in a different order give the same answer (a unit test feeds the same
signals reversed and shuffled). The function also returns the `evidence`:
the artifacts that decided the status, which the UI links to.

## 3. Filtering a derived value

`filterFor()` turns a status into ids: an inclusion list for most statuses,
an exclusion list for `no_development` (most items have no links). The ids
plug into the Prisma `where` of lists and backlog; trees and boards filter in
memory where the status is already on each card.

## 4. Auditing something you do not store

The status has no row, yet its changes matter. Every write that can change
it computes the status of the affected work items before and after, inside
the same transaction, and records one audit entry per change. To make the
"before" trustworthy under concurrency, those writes lock the work items
`FOR UPDATE` (after the artifact, always in id order): two links to the same
item are serialised, so the audit chain `from → to` never skips a step.

## Exercises

1. Cache the status in a projection table refreshed by the same writes and
   compare it with the derived value in a test.
2. Make "deployed" require the `production` environment per project.
