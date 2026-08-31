# Domain model

Source of truth: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).
This document explains the shape and the *why*; the schema is what runs.

## Entities

| Entity | Belongs to | Purpose | Soft delete |
| --- | --- | --- | --- |
| `User` | — | A person. Global, not per organization. | Yes |
| `Session` | `User` | One refresh-token family. Makes logout real. | No (revoked) |
| `Organization` | — | The tenant. | Yes |
| `OrganizationMember` | Organization | A user's role in an organization. | Yes |
| `OrganizationInvitation` | Organization | A pending invite, keyed by email. | No (status) |
| `Project` | Organization | Unit of work. Owns the key counters. | Yes |
| `ProjectMember` | Organization, Project | Optional per-project narrowing of the role. | No |
| `Requirement` | Organization, Project | What was asked for. | Yes |
| `RequirementVersion` | Organization | Append-only edit history. | No |
| `TestSuite` | Organization, Project | Container of cases. | Yes |
| `TestSection` | Organization, Suite | Hierarchical folder (self-referencing). | Yes |
| `TestCase` | Organization, Project, Suite | What will be verified. | Yes |
| `TestStep` | Organization, TestCase | Ordered step. | No (cascades) |
| `TestRun` | Organization, Project | An execution campaign. | Yes |
| `TestRunCase` | Organization, Run, Case | A case inside a run, **with its snapshot**. | No |
| `TestResult` | Organization, Run, RunCase | One execution attempt. Append-only. | Never |
| `Defect` | Organization, Project | A documented failure. | Yes |
| `AttachmentMetadata` | Organization | File metadata only (no storage yet). | Yes |
| `TraceabilityLink` | Organization | Polymorphic link between two entities. | No |
| `AuditLog` | Organization?, User? | Who did what. Append-only. | Never |
| `IntegrationConnection` | Organization | External system config. No credentials. | Yes |
| `ExternalReference` | Organization | "This local thing is that remote thing." | No |

## Relationships that carry the product

```
Organization 1─n Project 1─n Requirement
                     │            │ (TraceabilityLink: verifies)
                     │            ▼
                     ├─n TestSuite 1─n TestSection ──┐
                     │        └────────── 1─n TestCase 1─n TestStep
                     │                        │
                     ├─n TestRun 1─n TestRunCase (caseSnapshot) 1─n TestResult
                     │                                                  │
                     └─n Defect ◄───────────────────────────────────────┘
```

## Design decisions worth defending

**1. `organizationId` on every functional table, even when derivable.**
Turns isolation into one indexed predicate with no joins, and makes the rule
mechanically checkable. See [`security-model.md`](security-model.md).

**2. `TestRunCase.caseSnapshot` (JSONB).**
When a case enters a run, its title, preconditions, expected result and steps
are frozen. Editing the case afterwards must not rewrite what a past release
reported. Without this, every historical report silently becomes fiction.
`caseVersion` records which version was executed.

**3. `TestResult` is append-only.**
Re-running a case inserts a row; nothing is updated. The "current" status of a
case in a run lives in `TestRunCase.latestStatus`, a projection kept so that
listing a run does not need a correlated subquery.

**4. One polymorphic `TraceabilityLink` instead of six join tables.**
Link types will grow (releases, risks, automated tests). A new type must be a
new enum value, not a migration plus a table plus a repository.
The cost is no referential integrity on `sourceId`/`targetId`; it is paid with
a `LinkableEntity` enum (so a typo cannot create an orphan type), a unique
constraint on the whole tuple, and a check constraint forbidding self-links.

**5. Human-readable keys backed by per-project counters.**
`WEB-C-102`. Reserved with `UPDATE ... increment` inside the creating
transaction, so concurrent requests cannot collide and numbers are never reused.

**6. Only *one pending* invitation per organization and email.**
A partial unique index, not a plain unique constraint — the latter would also
block re-inviting somebody whose invitation was revoked or expired.

**7. Credentials never live in `IntegrationConnection`.**
It stores `secretRef`, a pointer into a secret manager. A database dump must
never yield a customer's Jira token.

**8. `Defect.testResultId` is nullable.**
Most defects are born from a failed result, but a defect found during
exploratory testing must still be recordable.

## Soft delete policy

| Data | Policy | Why |
| --- | --- | --- |
| Test results, audit log | Never deleted | They are the historical record |
| Requirements, cases, runs, defects, projects | `deletedAt` | Referenced by history and links |
| Steps, run cases | Cascade with their parent | Meaningless alone |
| Sessions | Revoked, then expire | Needed for the audit trail |

Every repository read goes through `active()`, which adds `deletedAt: null`.

## Key indexes

Every functional index leads with `organizationId`, because every query filters
by it:

```
projects              (organizationId, key) unique · (organizationId, status)
requirements          (organizationId, projectId, key) unique · (organizationId, projectId, status)
test_cases            (organizationId, projectId, key) unique · (organizationId, suiteId, sectionId)
test_run_cases        (testRunId, testCaseId) unique · (organizationId, testRunId, latestStatus)
test_results          (organizationId, testRunId, status) · (organizationId, testRunCaseId, executedAt)
defects               (organizationId, projectId, key) unique · (organizationId, assigneeId, status)
traceability_links    (organizationId, sourceType, sourceId) · (organizationId, targetType, targetId)
audit_logs            (organizationId, createdAt) · (organizationId, entityType, entityId)
```

## Enums

`OrganizationPlan`, `OrganizationRole`, `MembershipStatus`, `InvitationStatus`,
`ProjectStatus`, `RequirementType`, `RequirementStatus`, `Priority`,
`TestCaseType`, `TestCaseStatus`, `AutomationStatus`, `TestRunStatus`,
`TestResultStatus`, `DefectSeverity`, `DefectStatus`, `LinkableEntity`,
`TraceLinkType`, `IntegrationProvider`, `IntegrationStatus`, `AuditAction`.

Enums rather than lookup tables: these values are part of the application's
logic, not data a customer configures. When a customer needs custom statuses,
that becomes a per-organization configuration table — and a deliberate decision,
not a schema accident.
