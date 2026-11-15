# 71 — Exploratory testing: a state machine with frozen history

Phase S7-F5. Code: `packages/shared/src/exploratory/exploratory.contracts.ts`,
`apps/api/src/modules/exploratory/*` and the migration
`20270418100000_exploratory_sessions`.

## 1. The session is the aggregate

Notes, findings, links and the timeline only change through the session.
Every write locks the session row (`SELECT … FOR UPDATE`), checks its status
and optional `version`, writes the child row and bumps the session version.
That single lock is what serializes two testers acting on the same session.

## 2. Time is derived, not counted

The session stores `startedAt`, `pausedAt`, `pausedSeconds` and `endedAt`.
`sessionDurationSeconds()` computes active time from them, so a running or
paused session reports the right duration without a timer in the database.
Completing writes the final value once.

## 3. One active session per tester

`CREATE UNIQUE INDEX … WHERE "status" = 'active'` is a partial index: it only
constrains active rows. Two concurrent starts of different sessions by the
same tester cannot both commit; the loser gets a unique violation that the
service turns into 409.

## 4. Immutability in triggers

`exploratory_sessions_frozen()` compares `to_jsonb(NEW)` and `to_jsonb(OLD)`
without the columns archiving may touch. Any other difference on a completed
or cancelled session raises. The children trigger checks the session status
before a finding, event or link is written. The API checks first to answer a
clear 409; the triggers make the rule hold for every code path.

## 5. Finding → defect, exactly once

Converting locks the session and then the finding. A finding that already
has a defect answers 409, so two concurrent clicks create one defect. The
defect gets the next project key in the same transaction and is audited like
any other defect.
