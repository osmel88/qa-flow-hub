# 47 — A transactional outbox without a queue

> Phase S3-F5. ADR 0020. Code: `apps/api/src/modules/notifications`
> (`notifications.service.ts`, `notification-outbox.worker.ts`,
> `templates/template-payload.ts`), migration `20261122100000_notification_outbox`.

## 1. The problem with "send inside the request"

Until S3-F5 a domain event produced one ledger row and one provider call in the
same request. Two things could go wrong and stay wrong forever:

1. the provider answered "try later" → the row was `failed`, nobody retried;
2. the process died between the insert and the call → the row stayed
   `pending`, nobody noticed.

Both are the classic motivation for the **transactional outbox** pattern: write
the intent durably, then let a separate loop make it happen, as many times as
needed, until it is done or provably impossible.

## 2. The row is the job

We already had a durable row per message. Three columns turn it into a job:

| Column          | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `payload`       | Template variables, so a retry renders the same email           |
| `nextAttemptAt` | When a `failed` row becomes due again; `null` = no more retries |
| `leaseUntil`    | Until when somebody is working on it; others must keep away     |

A row is **due** when it has a payload and either it is `pending`, or it is
`failed` with `nextAttemptAt <= now()`, and nobody holds a live lease.

## 3. Claiming without double delivery: `FOR UPDATE SKIP LOCKED`

Two replicas (or two overlapping passes) must never send the same row. The
claim runs in one statement:

```sql
UPDATE notifications SET "leaseUntil" = now() + interval
WHERE id IN (
  SELECT id FROM notifications WHERE <due> ORDER BY ... LIMIT $batch
  FOR UPDATE OF c SKIP LOCKED
)
RETURNING id, "organizationId";
```

`FOR UPDATE` locks the candidate rows; `SKIP LOCKED` makes a concurrent claimer
skip them instead of waiting. When the statement commits, the lease column
records the claim, so even after the lock is gone, the next claimer sees a
live lease and moves on. If the worker crashes, the lease simply expires and
the row is due again — that is the crash recovery, for free.

The integration test `delivers each due row exactly once when two passes run
concurrently` runs two `drainOutbox()` calls with `Promise.all` and checks that
the provider saw each message once.

## 4. Crossing tenants on purpose, and only a little

RLS (chapter on ADR 0013) hides rows of other organizations from the runtime
role. A worker has no organization: it must see due rows of all of them. The
claim is therefore a `SECURITY DEFINER` function owned by the migration role,
callable by `qaflow_app`, returning only `(id, organizationId)`. Everything
else — reading the row, rendering, marking it sent — happens inside
`tenant.runForOrganization(organizationId)`, so RLS is back in force for the
content. Compare with `api_key_organization_for_prefix()` from chapter 45: the
same "narrow door" technique.

## 5. Untrusted JSON coming back from your own database

`payload` is JSON; dates are strings there, and a row from an older version (or
edited by hand) may not match the template any more. `template-payload.ts`
keeps a table `VAR_SHAPES` with every variable of every template and its kind
(`string`, `number`, `date`). Its type is a mapped type over
`EmailTemplateVars`, so the compiler refuses a shape that forgets a variable.
`fromPayload()` accepts the JSON only if keys and kinds match exactly; otherwise
the worker records `failed` with reason `payload_unreadable` instead of mailing
"Hello undefined".

## 6. Backoff and giving up

```text
delay(n) = min(NOTIFICATIONS_RETRY_BASE_MS · 2^(n-1), NOTIFICATIONS_RETRY_MAX_MS)
```

With the defaults (60 s base, 5 attempts): 1 min, 2 min, 4 min, 8 min, then
`nextAttemptAt = null`. A permanent failure (`mailbox_unavailable`) gets no
retry at all. The payload is kept on an exhausted row so an admin can still
press "Retry now".

## 7. Re-checking authorization at send time

Between the event and the retry, the world changes: the recipient may leave the
organization, lose the project grant, or mute the category. `decideSkip()` runs
on every attempt, not only on the first one, and a project message to someone
who can no longer see the project becomes `skipped / recipient_no_access`. This
is the time-of-check/time-of-use lesson applied to email.

## 8. Secrets at rest

An invitation payload contains the accept URL with its token. The moment a row
is `sent` or `skipped`, `payload` is set to `NULL`. The API view never includes
it. Only rows still waiting for a retry hold a token, and only until they are
delivered or the invitation expires.

## 9. A new event: `test_run.completed`

`TestRunsService.transition()` publishes it when a run reaches `completed`. The
listener computes failed/blocked counts and notifies the run creator and the
assignees of failed cases, except the person who completed the run. Dedupe key
`test_run_failed:<runId>:<userId>`: completing is terminal, so one mail per
person per run.

## 10. Exercises

1. Set `NOTIFICATIONS_MAX_ATTEMPTS=1` and explain why no failed row is ever
   claimed by the worker.
2. Remove `SKIP LOCKED` from the function and run the concurrency test. What do
   you observe, and why does it still pass or fail?
3. Why is the first attempt kept inside the request instead of always going
   through the worker? Consider tests, latency and the invitation flow.
4. Sketch what changes when a real provider is added: where would the
   provider's idempotency key come from?
