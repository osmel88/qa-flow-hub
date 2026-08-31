# 0009 — A test case is snapshotted when it enters a run

Status: accepted
Date: 2026-08-16

## Context

A test case is edited over time: a step is clarified, an expected result is
corrected, the title is rewritten. A test run records what was verified at a point
in time, and its results are the evidence a release is shipped on and an auditor
later asks about.

Those two facts collide. If a run points at the live case, then editing a step
today changes what last quarter's run claims to have verified. The product's second
principle — history is immutable — has no meaning unless this is resolved.

## Options

**Point at the live case.** Simplest, one source of truth, no duplication. A run
executed six months ago silently reports today's steps. Rejected: it makes the
audit trail change when unrelated data is edited, which is the definition of an
untrustworthy record.

**Version every test case and have runs point at a version.** Correct and general.
It also means a versioning scheme, a way to browse versions, rules about which
version is "current" and what happens to a run when a version is deleted — a
feature in itself, and one nobody asked for at this stage.

**Copy the executed content into the run.** Chosen. `TestRunCase` stores the
title and steps as they were when the case was added to the run.

## Decision

Adding a case to a run copies its content into `TestRunCase.caseSnapshot` (JSON)
together with `caseVersion`, the version counter of the case at that moment.
Results belong to the run case, not to the live case. The live case remains the answer to
"what should we test today"; the snapshot is the answer to "what was verified".

Requirements take the other approach deliberately: they have real versions, because
a requirement's *change* is itself information the customer wants to see ("this was
approved at v2, we tested v1"). A test case's history is only interesting as the
evidence attached to a run, so a copy is enough. Different questions, different
mechanisms — and that asymmetry is the decision, not an inconsistency.

## Consequences

**Good.** A past run is immutable without freezing the case library. Coverage and
audit answers stay stable. No versioning machinery, no "which version is current"
question, no cascade rules.

**Bad.** Duplicated content: a run does not benefit from a corrected typo, and a
tester may execute a snapshot that is known to be outdated. There is no UI hint
saying "the live case has changed since this run started", which would be the
natural follow-up.

**Also bad, and accepted.** Storage grows with runs × cases × steps. Steps are
small text; the alternative costs a feature.

**Consequence for deletes.** Since results reference the run case rather than the
case, soft-deleting a test case does not destroy history. Its traceability links are
purged (ADR 0010) but the evidence of what was executed survives, which is the
behaviour an auditor expects.
