# Product vision

## The problem

QA teams hold four kinds of information: what was asked for (requirements), what
will be verified (test cases), what was actually verified and when (runs and
results), and what broke (defects). In most teams these live in four different
places — a Jira project, a Confluence page, a spreadsheet, and someone's memory
— and the *links between them* live nowhere.

That missing layer is what makes the following questions unanswerable, and they
are the questions that decide whether a release ships:

- Which requirements of this release have **no** test coverage at all?
- Of everything executed for this release, what failed and which defect
  documents it?
- This defect was reopened. Which requirement is now at risk?
- Six months later, an auditor asks what exactly was verified before version
  2.3 went out. Can we produce it?

Tools exist (TestRail, Xray, Zephyr). They are expensive, heavy, and usually
sold to the enterprise rather than to the team doing the work.

## What qa-flow-hub is

A multi-tenant SaaS that keeps the QA chain intact and queryable:

```
Requirement → TestCase → TestRun → TestResult → Defect
                  ↕
            AutomatedTest (linked, not executed)
```

Every functional record belongs to an organization. A user can belong to several
organizations with a different role in each. No user ever sees data from an
organization they do not belong to — that is the product's first security
property, not a feature.

## Who it is for

| Role | What they get |
| --- | --- |
| QA lead | Coverage of requirements, run progress, where the team is blocked |
| Tester | A clear queue of assigned cases and a fast way to record results and raise defects |
| Project manager | Release readiness backed by data instead of opinion |
| Auditor / customer | A defensible record of what was verified, when, by whom |

## Principles

1. **The links are the product.** Anyone can store test cases. The value is in
   the traceability matrix and the coverage gaps it exposes.
2. **History is immutable.** Results are append-only and a test case is
   snapshotted when it enters a run. Editing a case must never rewrite what a
   past release reported.
3. **Isolation is not a feature, it is a precondition.** Enforced in four
   layers: the token, the guards, every repository query, and PostgreSQL Row
   Level Security applied to a database role that owns nothing.
4. **Integrate, do not replace.** Teams already use Jira and GitHub. The
   adapters (`IssueTrackerAdapter`, `TestManagementAdapter`,
   `AutomationProviderAdapter`) exist from day one so that integration is adding
   an implementation, not migrating the schema.
5. **Boring where it can be.** A modular monolith, one PostgreSQL, no queue and
   no Redis until something genuinely requires them.

## Scope of the first version

**In:** authentication with revocable sessions, organizations and invitations,
projects, requirements, suites and sections, test cases and steps, runs and
results, defects, traceability matrix, dashboard, audit log, integration
contracts, and a web client for all of it.

**Out, deliberately:** real calls to Jira/TestRail, email delivery, payments,
real file storage, project-scoped *visibility* (per-project roles exist and
change what you can do, not what you can see), production deployment. Each of these
has an extension point ready and an entry in
[`technical-debt.md`](technical-debt.md) explaining what is missing and why.

## What would make it commercially viable

Roughly in order:

1. **Real file attachments.** Today only metadata is stored. It is the most
   visible functional gap against TestRail and Xray: a tester cannot attach the
   screenshot of the failure.
2. **Jira integration.** Most teams will not adopt a second defect tracker. The
   realistic sell is "your defects stay in Jira, the traceability lives here".
3. **Email.** Invitations exist but nothing is delivered; onboarding a real team
   requires it.
4. **Import from TestRail / CSV.** Nobody retypes 2000 test cases. Import is the
   difference between a trial and a migration.
5. **Billing and plans.** `Organization.plan` exists so this becomes a module,
   not a schema migration.
6. **Automated test results ingestion.** From GitHub Actions or Playwright, so
   the coverage picture includes automation.

The detailed sequencing is in [`commercial-roadmap.md`](commercial-roadmap.md).

## What could sink it

- **A cross-tenant leak.** One incident ends the product's credibility. This is
  why isolation is enforced in four layers and covered by its own test suites.
- **Being a worse Jira.** If the defect module drifts towards competing with
  issue trackers instead of linking to them, we lose on features and on focus.
- **Enterprise isolation requirements.** Regulated customers may demand physical
  data separation. The shared-schema model supports a dedicated deployment per
  customer without a rewrite, but it is an operational cost to plan for.
