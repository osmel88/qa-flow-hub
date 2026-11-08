# 63 — Release pipeline: derived state and consistent snapshots

Phase S6-F2. Code: `apps/api/src/modules/releases/release-pipeline.service.ts`,
`packages/shared/src/releases/release-pipeline.contracts.ts`. Builds on
chapters 61 and 62.

## 1. Derive, don't store

A stored "stage status" would need updating from every deployment,
environment, defect and release change, and would drift the day one path
forgets. The pipeline is a pure function of rows that already exist:
`computePipelineStages()` takes the release status, whether a passed build
exists, the number of blocking defects and, per environment, the newest
non-cancelled deployment. It is unit-tested without a database.

## 2. One snapshot per read

The service reads seven things (environments, deployments, build, runs,
cases, defects, blocking defects). Under READ COMMITTED each query could see
a different moment: a stage could say `deploying` next to a last deployment
that already `succeeded`. Running them in one REPEATABLE READ transaction
gives every query the same snapshot; the integration test reads the
pipeline while deployments move and checks each answer agrees with itself.

## 3. Rollbacks and history

A rollback deployment points to the original; the pipeline treats it as
"not deployed" for the release. Archived environments are not stages, but
the release's deployments there stay visible as history.

## Exercises

1. Add a blocker for a QA run that failed in the previous stage.
2. Link test runs to environments by id instead of by name.
