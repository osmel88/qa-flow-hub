# Commercial roadmap

[`product-vision.md`](product-vision.md) lists what would make qa-flow-hub sellable.
This document sequences it: what to build in what order, why that order, and what
each step costs. It is a product document with engineering constraints in it, not a
sales plan.

Two rules govern the ordering:

1. **Nothing before the thing that blocks a trial.** A feature nobody reaches is
   worth zero, however good.
2. **Nothing that risks the isolation guarantee.** One cross-tenant leak ends the
   product. Any step that touches tenancy pays for its own test suite first.

## Where the product is today

Complete and tested: authentication with revocable sessions, organizations and
invitations, projects with per-project roles, requirements with versions, suites,
sections, cases and steps, runs, results and assignments, defects, the traceability
matrix, a dashboard, an append-only audit log, and a web client for all of it.
Isolation is enforced in four layers and proved by its own suite.

Missing for a real customer, in one sentence: **nobody receives an email, nobody can
attach a screenshot, and nothing can be imported.**

## Stage 0 — Before a single external user (blockers)

| # | Item | Why it blocks | Cost |
| --- | --- | --- | --- |
| 0.1 | **Email delivery** | Invitations exist and are audited, but the token comes back in the API response. Onboarding a team is impossible, and the token in the response must not survive contact with production (debt 4, 10) | Small: one adapter, one template set, the call sites already exist |
| 0.2 | **Password recovery** | Every user who forgets a password is a support ticket you cannot resolve | Small once 0.1 exists |
| 0.3 | **File attachments** | Only metadata is stored. A tester cannot attach the screenshot of the failure — the most visible gap against TestRail and Xray (debt 2) | Medium: object storage, signed uploads, size and type limits, virus scanning is a decision |
| 0.4 | **Error tracking and metrics** | Today an incident is discovered by a customer telling you | Small: one SDK plus a `/metrics` endpoint |

Stage 0 is not features, it is the difference between a demo and a product.

The agreed execution plan for the stage after the MVP lives in
[`stage-2-roadmap.md`](stage-2-roadmap.md): the stages below say *why* an order
sells, that document says *what* each phase delivers and where it stops.

## Stage 1 — First paying team

| # | Item | Why now | Cost |
| --- | --- | --- | --- |
| 1.1 | **Jira integration (real)** | Most teams will not adopt a second defect tracker. The sell is "your defects stay in Jira, the traceability lives here". The ports exist (debt 18) | Medium-high: OAuth or token per organization, field mapping, rate limits, idempotency |
| 1.2 | **CSV / TestRail import** | Nobody retypes 2000 cases. Import is the difference between a trial and a migration | Medium: mapping UI, dry run, partial failure reporting |
| 1.3 | **Matrix and run export (CSV/PDF)** | The artefact customers actually send to auditors and clients | Small for CSV, medium for PDF |
| 1.4 | **Billing and plans** | `Organization.plan` exists, so this is a module and not a schema migration | Medium: provider integration, limits enforcement, invoices |
| 1.5 | **Shared rate limiting** | With more than one replica the limit is `max × replicas` (debt 1) | Small, but introduces Redis as a dependency |

## Stage 2 — Team of teams

| # | Item | Why | Cost |
| --- | --- | --- | --- |
| 2.1 | **Project-scoped visibility** | Per-project roles change what you can *do*, not what you can *see* (debt 22). A customer with two client teams asks for this in week one | Medium, and it touches tenancy: needs its own tests |
| 2.2 | **Automated result ingestion** | JUnit/Playwright reports from CI, so coverage includes automation. `AutomatedTest` already models the link | Medium: an ingestion endpoint, API keys, matching rules |
| 2.3 | **API keys for machine clients** | CI needs a credential that is not a session refresh token (debt 20) | Small-medium: scopes, rotation, audit |
| 2.4 | **Release as a first-class entity** | "What was verified before 2.3" is answered through runs today; auditors ask by release | Medium: a new entity plus report changes |
| 2.5 | **Notifications** | A failed run or a reopened defect should reach Slack or email without polling | Medium: needs the job runner (debt 3) |

## Stage 3 — Enterprise

| # | Item | Why | Cost |
| --- | --- | --- | --- |
| 3.1 | **SSO/SAML and SCIM** | A hard procurement requirement above a certain company size | High |
| 3.2 | **MFA** | Same, and cheaper | Medium |
| 3.3 | **Custom fields and workflows** | Enterprise QA processes never match the defaults | High, and it is the feature most likely to rot the data model |
| 3.4 | **Audit retention and export to an external store** | Retention has no policy (debt 19), and whoever holds the migration credential can still rewrite history | Medium |
| 3.5 | **Dedicated deployment per customer** | Regulated customers demand physical separation. The shared-schema model supports it without a rewrite, but it is an operational cost | High, operational rather than code |

## What is deliberately not on this roadmap

- **Replacing Jira.** If the defect module drifts towards competing with issue
  trackers, we lose on features and on focus. Defects here exist to close the
  traceability chain.
- **Running tests.** This is not a test runner. Automated tests are linked and their
  results ingested; execution stays where it already works.
- **Microservices.** A modular monolith with one PostgreSQL is the right shape for
  this workload and this team size (ADR 0007). Splitting is an answer to a scaling
  problem that does not exist.
- **A mobile app.** The work happens on a desktop.

## How the technical debt maps to revenue

The debt file is not a wish list; roughly, its entries fall into three buckets:

- **Blocks a sale:** email (4, 10), attachments (2), project visibility (22), API
  keys (20).
- **Blocks scale, invisible until it bites:** shared rate limiting (1), job runner
  (3), dashboard aggregation (16), matrix pagination (14, 17).
- **Deliberate and possibly permanent:** noop adapters until a customer names their
  tracker (18), single OpenAPI version (13), lazy invitation expiry (12).

That mapping is the point of writing debt down with a trigger. When a customer asks
for something, the answer is not a guess: it is an entry with a cost already
estimated.

## Related

- [`stage-2-roadmap.md`](stage-2-roadmap.md) — the approved S2 phases, in execution order
- [`product-vision.md`](product-vision.md) — the problem and the principles
- [`integrations-roadmap.md`](integrations-roadmap.md) — the shape of each integration
- [`technical-debt.md`](technical-debt.md) — every entry with its trigger
- backend course, chapter 39 — the same sequencing, explained as study material
