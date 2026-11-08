# 66 — Rollback: append, never rewrite

Phase S6-F5. Code: `apps/api/src/modules/development/deployments.service.ts`
(`rollbackEnvironment`), `packages/shared/src/development/deployment.contracts.ts`.
Builds on chapters 61, 62, 64 and 65.

## 1. A rollback is a new deployment

Going back to an earlier version does not edit the earlier row. A new
`rollback` deployment carries the target's build and release and points to
both the deployment it replaced (`rollbackOfId`) and the one it went back to
(`rollbackTargetId`). The history reads as it happened.

## 2. Keep one lock order

Every deployment write locks deployment rows first, then the environment.
The rollback follows it (current → target → environment), so it cannot
deadlock against a transition or another rollback.

## 3. Races and retries are different problems

Two different rollbacks racing must not both win: the loser finds the
current deployment already `rolled_back` and answers 409. The same request
retried must not create two rollbacks: an idempotency key stored in
`externalId` (unique per project) makes the retry return the first result.

## 4. Policy as data, escape hatch as a permission

`rollbackChecks` on the environment decides whether a rollback must pass the
gates and approvals of the release it goes back to. An emergency rollback
skips them, but only with its own permission and a reason, and leaves its own
audit trail.

## Exercises

1. Report a rollback as `deploying` first and let a provider finish it.
2. Create a follow-up task after every emergency rollback.
