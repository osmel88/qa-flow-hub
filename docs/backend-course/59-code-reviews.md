# 59 — Code reviews: one decision per reviewer, a status under a lock

Phase S5-F3. Code: `apps/api/src/modules/code-reviews/`,
`packages/shared/src/code-reviews/code-review.contracts.ts`. Builds on
chapters 57 and 58.

## 1. Model

A review has reviewers (one row and one decision each), linked work items,
an optional pull request artifact and an append-only history. Every foreign
key to a project resource carries `projectId`, so the database itself
refuses a review of another project's pull request or work item.

## 2. A stored status that cannot drift

Unlike the development status, the review status is stored, because lists
filter by it. It never drifts: every write locks the review row
(`FOR UPDATE`), changes one decision, then recomputes the status with
`computeCodeReviewStatus()` in the same transaction. Two reviewers acting at
once are serialised by that lock; a duplicate approval sees the first one and
answers 409.

## 3. Rules that are not permissions

`code_reviews.review` says who may review in a project. On top of it, the
service checks being an assigned reviewer and not being the author. When a
reviewer loses access, their approval stays in the history but stops
counting toward merge readiness, which is derived on every read.

## 4. Feeding the development status

A review linked to a work item, directly or through its pull request, is one
more signal for `computeDevelopmentStatus()`: approved reviews raise the item
to `pr_approved`. Signals are loaded with model queries: a raw query outside
a transaction does not carry the tenant to Row Level Security and returns
nothing (the bug the integration test caught).

## Exercises

1. Reset approvals when a new commit is linked to the reviewed pull request.
2. Batch the reviewer permission checks into one query.
