# Integrations roadmap

No integration in this document performs a real external call yet. What exists
today is the shape that makes adding one a matter of writing an adapter rather
than migrating tables: `IntegrationConnection`, `ExternalReference`, and an
internal event bus.

This is written now, in the phase that created those tables, so the extension
points are recorded while the reasons are fresh.

## The two tables that make this possible

**`IntegrationConnection`** — one configured connection per organization and
provider: `provider`, `status`, `config` (JSONB, non-secret), `credentialRef`
(a pointer to a secret, never the secret), `lastSyncedAt`, `lastError`.

Credentials are referenced, not stored. A Jira API token in a JSONB column would
be readable by anyone with a database session and would end up in a backup. The
column holds an identifier that a secret manager resolves.

**`ExternalReference`** — a polymorphic link between one of our entities and its
counterpart in another system: `entityType`, `entityId`, `provider`,
`externalId`, `externalKey`, `externalUrl`, `syncedAt`.

Because it is polymorphic, connecting a new provider or a new entity type adds
rows, not columns. A requirement can point at a Jira issue and at a Confluence
page at once, and nothing about `requirements` changes.

## Email — the first real integration

This is the one the product already needs, and the only one whose absence is
visible today: invitations exist, work and are audited, but nobody receives a
message. The token is returned in the API response instead, which is acceptable
for an MVP and **must not survive contact with production**.

What is already in place:

- `InvitationsService.invite()` and `.resend()` are the only two call sites;
- `resend()` already does the operation that matters — new token, new expiry,
  previous token dead — so "sending" is the only missing part;
- `WEB_BASE_URL` produces the acceptance link, so the URL never comes from a
  request header. A forged `Host` cannot mint a link we would send;
- `lastSentAt` and `resendCount` are already recorded.

What wiring a provider looks like:

1. `EmailPort` interface in `apps/api/src/integrations/email/`:
   `send(message: OutboundEmail): Promise<void>`.
2. Two implementations: `ConsoleEmailAdapter` (logs, used in development and
   tests) and one real adapter (Resend, Postmark or SES). The choice is
   configuration, not code.
3. `InvitationsService` emits `invitation.issued`; a listener sends the email.
   The service does not learn what email is, which keeps the transaction short —
   an HTTP call inside a database transaction is how connection pools die.
4. A transactional outbox once delivery matters: the event row is written in the
   same transaction as the invitation, and a worker delivers it. Without it,
   "invitation created but email never sent" is a silent failure.
5. Stop returning `token` and `acceptUrl` from the API. That change is the
   definition of done for this item.

Templates and provider choice are deliberately not decided here.

## Adapter contracts

Three ports, one per kind of external system. They are described here and will
be written as TypeScript interfaces in F8, next to noop implementations that
satisfy them.

**`IssueTrackerAdapter`** — Jira, GitHub Issues, Linear.

```
createIssue(defect)            -> ExternalReference
updateIssue(reference, defect) -> void
fetchIssue(reference)          -> ExternalIssue
linkRequirement(requirement)   -> ExternalReference
```

**`TestManagementAdapter`** — TestRail, Xray. Mostly for migration in, which is
how customers arrive.

```
importSuites(projectId)  -> ImportSummary
importCases(suiteId)     -> ImportSummary
exportRun(testRunId)     -> ExternalReference
```

**`AutomationProviderAdapter`** — Playwright, GitHub Actions, any CI.

```
linkAutomatedTest(testCaseId, ref) -> ExternalReference
ingestResults(payload)             -> TestResult[]
fetchRunStatus(reference)          -> AutomationRunStatus
```

`ingestResults` is the interesting one commercially: it is what lets an
automated suite report into the same run as manual execution, so the traceability
matrix covers both. It is also the reason `TestResult` is append-only.

## Order, and why

| Order | Integration | Why it comes here |
| --- | --- | --- |
| 1 | Email | Invitations are incomplete without it |
| 2 | Automation ingest | The differentiator: manual and automated in one matrix |
| 3 | Jira | Most requested in QA tooling; defects flow both ways |
| 4 | TestRail import | Removes the switching cost for a customer leaving TestRail |
| 5 | GitHub | Link commits and PRs to test cases |

## Constraints any adapter must respect

**Never inside a transaction.** External calls are slow and fail in ways a
database transaction cannot express. They run after commit, driven by events.

**Idempotent.** Networks retry. Creating the same Jira issue twice must be
impossible; `ExternalReference` is checked first and is unique per
`(provider, entityType, entityId)`.

**Failure is a state, not an exception.** A provider being down cannot fail the
user's operation. Failures are recorded in `lastError` and surfaced in the UI.

**Tenant-scoped.** A connection belongs to an organization. There is no global
Jira connection, ever.

**Secrets by reference.** See above.

## Webhooks

Inbound webhooks (a Jira status change, a CI run finishing) need signature
verification, replay protection and a queue — none of which exist yet. When they
arrive they go in their own module with their own rate limits, because a webhook
endpoint is a public endpoint.
