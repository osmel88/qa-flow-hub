# 0020 — The notification ledger is also the outbox, drained in-process

Status: accepted
Date: 2026-11-22
Related: [0006](0006-multi-tenancy-strategy.md),
[0013](0013-row-level-security-with-non-owning-role.md),
[0017](0017-project-visibility-through-grants.md)

## Context

S2-F6 delivered email inside the request that raised the domain event. A
`failed` row stayed failed, and a crash between the insert and the provider
call left a `pending` row nobody would ever pick up (debt 32). The roadmap item
2.5 ("a failed run should reach people without polling") needed a retrying
delivery path, and there is still no job runner (debt 3), no Redis and no
queue, and none may be added without approval.

## Options evaluated

| Option                                    | New infrastructure    | Exactly-once per replica set | Cost                     |
| ----------------------------------------- | --------------------- | ---------------------------- | ------------------------ |
| Queue (BullMQ/Redis, SQS)                 | Yes                   | Broker semantics             | Not allowed in Stage 3   |
| Separate outbox table + worker            | No                    | `SKIP LOCKED`                | Second table, two writes |
| **Ledger row doubles as outbox + worker** | No                    | `SKIP LOCKED` + lease column | Three nullable columns   |
| pg-boss / graphile-worker                 | A dependency + schema | Library semantics            | New schema to operate    |

## Decision

- `notifications` gains `payload` (template variables as JSON), `leaseUntil`
  and `nextAttemptAt`. The row the product already shows is the unit of work.
- The **first attempt stays in the request**, so behaviour and tests from S2-F6
  are unchanged when the provider answers. A transient failure schedules
  `nextAttemptAt = attemptedAt + min(base · 2^(n-1), max)`; a hard bounce
  (`mailbox_unavailable`) and the last allowed attempt set it to `null`.
- `NotificationOutboxWorker` runs `drainOutbox()` every
  `NOTIFICATIONS_WORKER_INTERVAL_MS` in every API replica, never overlapping
  itself. Rows are claimed by `claim_notification_deliveries(batch, lease)`, a
  `SECURITY DEFINER` function that leases due rows with
  `FOR UPDATE SKIP LOCKED` across tenants and returns **only** `id` and
  `organizationId`. Each row is then read and sent inside
  `runForOrganization(organizationId)`, so RLS applies to its content exactly
  as in a request.
- Access is **re-checked at send time**: preferences, active membership and,
  for project messages, visibility of the project (ADR 0017). A recipient who
  lost access is `skipped` with `recipient_no_access`.
- `payload` is cleared as soon as a row is `sent` or `skipped`: it may contain
  an invitation link with its token, and it is never returned by the API.
- Owners and admins can force a retry (`POST /notifications/:id/retry`,
  audited). A leased row answers 409, so the manual path never races the worker.
- New event `test_run.completed`: when a completed run has failed cases, the
  run creator and the assignees of failed cases (not the actor) get
  `test_run_failed`, category `status_changes`.

## Consequences

- No new infrastructure; the worker is one `setInterval` per replica and the
  database is the coordinator. Throughput is bounded by
  `NOTIFICATIONS_WORKER_BATCH` per interval per replica.
- The claim function is a deliberate, narrow RLS bypass (like
  `api_key_organization_for_prefix()` in ADR 0018): it can list ids across
  tenants but cannot read or change content beyond the lease.
- Rows written before this migration have no payload and are never retried.
- Delivery is at-least-once: a process that dies after the provider accepted
  but before `markSent` will send again when the lease expires. Providers'
  idempotency keys (the row id) are the remedy once a real one exists.
