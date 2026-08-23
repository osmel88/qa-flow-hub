# Traceability model

The traceability layer is the product. Anyone can store test cases; the value is
being able to answer "what is not covered", "what was verified before release 2.3"
and "which requirement does this reopened defect put at risk". This document is the
semantics of that layer: what a link means, what coverage means, and — the part
that decides whether the report is trustworthy — what it deliberately does **not**
mean.

## The chain

```
Requirement ──covers──▶ TestCase ──▶ TestRunCase ──▶ TestResult ──▶ Defect
     ▲                                                                │
     └──────────────────── affects ───────────────────────────────────┘
```

Two of those arrows are structural (a result belongs to a run case, which belongs
to a run) and two are `TraceabilityLink` rows: requirement→case and
defect→requirement. That split matters: the structural ones cannot be wrong, while
the links are asserted by a human and are therefore the part that needs rules.

## One polymorphic table

`TraceabilityLink` holds `sourceType`, `sourceId`, `targetType`, `targetId`,
`linkType` and `organizationId`. Linking a new pair of entity types adds rows, not
columns, and the matrix query does not change shape.

The cost is explicit and tracked (technical debt 14): a polymorphic link **cannot
have foreign keys**. The database will not stop a row that points at nothing. What
protects integrity instead:

1. **On create**, both ends must resolve to a *live* entity in the caller's
   organization, and the caller must be allowed in that end's project. A link to a
   deleted entity is a `400`, not a silently orphaned row.
2. **On delete**, the links are purged in the same transaction as the soft delete
   of either end, in both directions. Nothing survives its endpoint.
3. **On read**, the matrix skips a case it cannot resolve. Unreachable today, kept
   as defence in depth: in a report, guessing is worse than showing less.

What is still not covered: a direct SQL write can create an orphan. The trigger for
fixing it is an integrity job, and until then the exposure is "someone with the
owner credential", which is the same exposure as the audit trail.

## Both ends are checked, always

```ts
// Removing a link changes what the matrix reports for the requirement *and* for
// the case, so being allowed to edit either project alone is not enough.
await this.locateEnd(link.sourceType, link.sourceId);
await this.locateEnd(link.targetType, link.targetId);
```

Two consequences worth stating:

- **A link cannot be used as an existence oracle.** Pointing at an id from another
  organization gets the same answer as pointing at an id that never existed.
- **Editing a link needs permission on both projects.** A link is a claim about two
  things; holding rights over half of it is not enough to change what the report
  says.

## Coverage is not verification

The single most important distinction in the product, and the reason the matrix can
be shown to an auditor:

| Term | Definition | Fails when |
| --- | --- | --- |
| **Covered** | The requirement has at least one **live** linked test case | Nobody wrote a test, or the only test is archived |
| **Verified** | Covered, **every** live linked case's latest result is `passed`, **and** no outstanding defect is linked to the requirement | A case is untested or failed, or a defect linked to the requirement is still open |

```ts
covered: active.length > 0,
verified:
  active.length > 0 &&
  active.every((testCase) => testCase.lastStatus === 'passed') &&
  (defectsByRequirement.get(requirement.id) ?? []).length === 0,
```

`every`, not `some`: one untested case is enough to make the requirement
unverified. A report that rounds in its own favour is worse than no report, because
someone will ship on it.

## Archived cases: visible, not counted

Archiving is not deleting. The case still exists, read-only, and its link stays —
archiving is reversible and destroying the link would make restoring lossy.

So an archived case:

- **stays in the matrix row**, flagged `archived`, so the reader can see *why*
  coverage dropped instead of losing a line;
- **does not count** towards `covered` or `verified`, because a requirement whose
  only test is deprecated is not tested in any useful sense;
- **counts again automatically** when the case is restored: nothing is recreated,
  because nothing was destroyed.

## Snapshots: history cannot be rewritten

When a case enters a run, its title and steps are **copied** into the run case. Two
questions, two answers:

- "What should we test today?" → the live `TestCase`.
- "What was verified in release 2.3?" → the snapshot in the run.

Without the copy, editing a step would retroactively change what a past release
claims to have verified — an audit trail that changes when you edit unrelated data
is not an audit trail. The cost is that a run does not benefit from a corrected
typo, which is exactly the intended trade.

## Reading the matrix

`GET /traceability/matrix?projectId=…` returns one row per requirement plus a
summary: `requirements`, `covered`, `verified`, `coverage` (a percentage with one
decimal), `uncovered`, `openDefects`. `uncoveredOnly=true` filters the rows and
**not** the summary — the totals must stay comparable between views, or the filter
becomes a way to make the number look better.

Four queries build it, none of them per requirement: requirements, requirement→case
links, defect→requirement links, then cases plus their latest statuses in parallel.
The grouping happens in two maps in memory. Chapter 34 covers why.

## What the model cannot tell you

Stated here because a traceability tool that oversells itself is a liability:

1. **A link means "somebody said so".** There is no check that a test case actually
   exercises the requirement it claims to cover (debt 17). Coverage counts links,
   not intent.
2. **Automated tests are linked, not executed.** `AutomatedTest` records the
   relationship to a case; nothing runs a Playwright suite from here, and no
   external run feeds results back in yet.
3. **There is no release object.** "What was verified before 2.3" is answered
   through runs, not through a first-class release entity.
4. **Defect→requirement links are asserted too.** A defect derived from a failed
   result gets its origin link automatically; anything wider is a human judgement.
5. **A link carries no time.** The matrix is always "as of now"; there is no
   history of when coverage appeared or disappeared, only the audit log of the
   links themselves.

## Related

- backend course chapter 26 — how it is implemented, with the queries
- [`domain-model.md`](domain-model.md) — the entities
- [`adr/0010-polymorphic-traceability-links.md`](adr/0010-polymorphic-traceability-links.md) — why one polymorphic table
- [`technical-debt.md`](technical-debt.md) — entries 14, 17 and 22
