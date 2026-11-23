# 77 — Release readiness report (S7-F8)

This chapter explains how a release gets a `GO` / `GO WITH RISKS` / `NO-GO` /
`INSUFFICIENT DATA` answer without a new table. The contract (thresholds and
every rule) lives in `docs/stage-7-roadmap.md` § S7-F8; read it alongside.

## 1. Derived, not stored

A readiness decision is a function of data that already has owners: gates,
results, defects, links, flaky marks, sessions. Storing the answer would
create a second source of truth that goes stale the moment a defect is
closed. So `GET /releases/:id/readiness` recomputes everything and stamps the
answer with `computedAt`. The cost is a handful of queries per read, which is
fine for a page a release manager opens a few times a day.

## 2. Split: facts in the API, decision in shared

`ReleaseReadinessService` (`apps/api/src/modules/releases`) only _gathers
facts_ and builds a `ReadinessFacts` object:

```ts
const summary = await this.releases.summary(releaseId);
const trace = await this.releases.traceability(releaseId);
const gates = await this.gates.evaluate(releaseId, {});
```

The _decision_ is a pure function, `decideReadiness(facts)` in
`packages/shared/src/releases/release-readiness.contracts.ts`. Pure means no
database and no clock, so every rule is unit-tested with plain objects and
the same function could run in the browser. This is the same split used for
`executionKpis()` and `analyzeFlakiness()`.

## 3. Reuse instead of re-implementing

- Gate results come from `QualityGatesService.evaluate()`; readiness never
  re-evaluates a gate.
- Execution counts come from `executionKpis()` and rates from
  `sampledRates()`, so the "no percentage under 5 verdicts" rule from the QA
  metrics dashboard applies here too.
- Flaky detection gained `FlakyService.views(projectId, caseIds?)`, a
  refactor of `statusCounts()`, so readiness gets the full per-case view
  (detected status + manual mark) through the S7-F6 code path.
- Requirements coverage reads `ReleasesService.traceability()` rows.

New SQL exists only where no owner did: `ReleaseReadinessRepository` lists
plans, cycles and exploratory sessions linked to the release. It extends
`TenantAwareRepository`, so every query filters by organization and runs in a
tenant transaction under RLS.

## 4. Order of the rules

```text
blockers?            -> NO-GO
verdicts < 5?        -> INSUFFICIENT DATA
warnings?            -> GO WITH RISKS
else                 -> GO
```

Why do blockers beat insufficient data? An open critical defect is a reason
not to ship regardless of how many tests ran; saying "insufficient data"
would hide a known stopper. Why does insufficient data beat warnings? With
fewer than five verdicts the warnings are not representative, and "GO WITH
RISKS" would sound like permission.

## 5. Explainability

Every reason carries `code`, `source`, `severity`, `count`, an English
`message` and up to N linked `items` (id + label). The API message makes the
JSON readable for scripts and logs; the Web ignores it and translates by
`code` with `{count}`, `{min}` and `{max}` placeholders, so Spanish users get
a real sentence, with plural forms from `Intl.PluralRules`.

## 6. Security

The controller is `@ProjectScoped()` with `@RequirePermission('analytics.read')`.
The project comes from the release row, not from the request, so a forged
`X-Project-Id` cannot widen access, and a release from another organization
is a 404 because RLS never returns its row. A project-level revoke of
`analytics.read` answers 403. Both are integration-tested.

## 7. Exercises

1. Add a "required test plan" concept and turn `plan_incomplete` into a
   blocker only for required plans.
2. Make `READINESS_MAX_FAILED_RATE` configurable per project; where would the
   value live so the pure function stays pure?
3. Evaluate gates per environment and show one decision per environment.
