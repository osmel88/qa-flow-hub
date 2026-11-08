# 65 — Release approvals: history as the source of truth

Phase S6-F4. Code: `apps/api/src/modules/releases/release-approvals.service.ts`,
`packages/shared/src/releases/release-approval.contracts.ts`. Builds on
chapter 64.

## 1. Store decisions, derive the state

There is no `status` column for an approval workflow. Rules say what is
needed; `release_approvals` records who decided what. The state is
`deriveApprovalRequirements()` + `combineApprovalStates()` over the live
(non-revoked) decisions, so revoking a decision changes the next answer
with nothing to recompute.

## 2. Revoking is a fact too

A revocation fills `revokedAt`, `revokedById` and `revokeReason`; the
database grants the app `UPDATE` on those three columns only, and no
`DELETE`. The full history stays readable and auditable.

## 3. Let the database settle races

"One live decision per approver, type and scope" is a partial unique index
(`WHERE "revokedAt" IS NULL`). Two concurrent decisions by the same person
cannot both win: one insert fails with P2002 and becomes a 409. Different
approvers do not conflict, and approve vs reject from two people simply
yields `rejected`.

## 4. Check permissions where you write

The screen may show buttons from a permission that was just revoked. The
service calls `assertPermission(projectId, 'releases.approve')` on every
write, so the stale screen gets a 403 and refreshes.

## 5. Two independent locks on a deployment

Quality gates and approvals are separate checks in the same deployment
transaction. Passing one never implies the other.

## Exercises

1. Bind approval types to roles (only QA leads give `qa`).
2. Expire approvals when a newer build of the release passes.
