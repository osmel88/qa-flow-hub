# 61 — Deployments: environments, rollback once and the database as referee

Phase S5-F5. Code: `apps/api/src/modules/development/deployments.service.ts`,
`packages/shared/src/development/deployment.contracts.ts`. Builds on chapter 60.

## 1. Same artifact, more references

A deployment is still the `deployment` artifact. It now points to an
environment, a build and, for a rollback, the deployment it replaces. Every
reference is a composite foreign key with `projectId`, so a build or an
environment of another project (or tenant) is impossible even if the
service forgot to check.

## 2. The minimum environment

`environments` has a name and a kind, unique per project ignoring case. It is
enough to deploy to; protection rules and approvals belong to Stage 6.

## 3. Rollback exactly once

The rollback locks the original (`FOR UPDATE`), checks it is `succeeded`,
marks it `rolled_back` and inserts the rollback deployment. Racing calls
wait on the lock and then see `rolled_back` (409). The partial unique index
on `rollbackOfId` is the last line: even a path that skipped the lock could
not create two live rollbacks.

## 4. Status follows reality

Development status counts only `succeeded` deployments, so rolling back
takes the work item out of `deployed` without storing anything.

## Exercises

1. Require `work_items.manage` to roll back production environments.
2. Let a real adapter report the rollback as `pending → deploying → succeeded`.
