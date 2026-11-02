# 60 — Builds: a lifecycle, idempotent reports and secrets that never land

Phase S5-F4. Code: `apps/api/src/modules/development/builds.service.ts`,
`packages/shared/src/development/build.contracts.ts`. Builds on chapters
57 and 58.

## 1. Extend, do not duplicate

S5-F1 already stored builds as development artifacts. A second `builds`
table would have meant two truths for links and development status, so the
artifact gained the CI columns instead, with a CHECK that keeps them null
on other kinds and a composite foreign key that keeps the release in the
project.

## 2. A lifecycle under a row lock

`BUILD_TRANSITIONS` is the whole state machine. A transition locks the
artifact (`FOR UPDATE`), checks the move, sets the start/finish time and
audits; three concurrent "finish" calls on a running build give one winner
and two 422s. Terminal statuses go nowhere: a re-run is a new build.

## 3. Idempotent reports

CI systems retry. `POST /builds` looks up (provider, externalId) first; when
two reports race, the partial unique index rejects the loser (`P2002`), which
then reads and returns the winner, so every caller gets 200 and one row.

## 4. Never store a secret

Logs and metadata pass through `redactSecrets()` (tokens, bearer headers,
`password=`, credentials in URLs, private keys) and sensitive fact names are
masked before the row is written: redacting on read would leave the secret
in backups.

## Exercises

1. Add pipeline stages as child rows of a build.
2. Roll metrics up per day in a table refreshed by transitions.
