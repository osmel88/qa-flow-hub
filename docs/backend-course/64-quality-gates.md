# 64 — Quality gates: rules as data, results as functions

Phase S6-F3. Code: `apps/api/src/modules/releases/quality-gates.service.ts`,
`packages/shared/src/releases/quality-gate.contracts.ts`. Builds on
chapters 62 and 63.

## 1. Store the rule, compute the result

A gate row stores what must hold (rule types and thresholds). Whether it
holds is `evaluateQualityGateRule(rule, facts)`, a pure function over facts
read from one snapshot of the release. Closing a defect, a passing build or
a completed run changes the next answer with nothing to invalidate.

## 2. Pending is not failed

Missing data (no executed tests, no build, no review) is `pending`, not
`failed`: the gate cannot say yes yet, but nothing is wrong either. Both
block a protected environment; only the message differs.

## 3. Enforce where the write happens

The deployment service evaluates the required gates inside its own
transaction, after locking the environment, so a deployment and a gate edit
or an override cannot interleave into "allowed by a gate that no longer
exists".

## 4. Overrides are evidence

An override is an append-only row with a mandatory reason and the status it
overrode, plus an audit entry; the database refuses updates and deletes.

## Exercises

1. Make an override expire after 24 hours.
2. Add a rule on the release target date.
