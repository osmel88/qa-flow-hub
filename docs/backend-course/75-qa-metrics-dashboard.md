# 75 — QA metrics dashboard (S7-F7)

This chapter explains how the QA metrics dashboard is built without adding a
new source of truth. Read it with `docs/stage-7-roadmap.md` § S7-F7 open: that
section is the contract for every KPI.

## 1. The design rule: aggregate, never copy

Every number on the page already had an owner:

| KPI                        | Owner reused                                                   |
| -------------------------- | -------------------------------------------------------------- |
| Execution counts and rates | `executionKpis()` in `packages/shared/src/analytics`           |
| Window, buckets            | `resolveAnalyticsPeriod()`, `bucketStarts()`, `truncate()`     |
| Plan / cycle progress      | `TestPlansService.progress()` / `TestCyclesService.progress()` |
| Flaky status               | `analyzeFlakiness()` / `FlakyService` (S7-F6)                  |

The new code only adds aggregate SQL where no owner existed (open defects by
severity, exploratory sessions and findings) and two pure functions in
`packages/shared/src/qa-metrics/qa-metrics.contracts.ts`:

- `sampledRates()` hides pass/fail/blocked rates below
  `QA_METRICS_MIN_VERDICTS` (5) and flags `insufficientData`;
- `defectDensity()` returns `null` below
  `QA_METRICS_MIN_EXECUTED_FOR_DENSITY` (20 executed run cases).

A percentage over a tiny denominator is worse than no percentage: "100% pass
rate" from one result misleads a release decision. The API therefore returns
the counts always and the rates only when they mean something; the UI writes
"Not enough data" and explains the threshold.

## 2. Module wiring

`QaMetricsController`, `QaMetricsService` and `QaMetricsRepository` live in
`apps/api/src/modules/dashboard`, next to the analytics dashboards, and share
their permission (`analytics.read`) and `@ProjectScoped()` guard. To reuse the
plan, cycle and flaky services the `TestPlansModule` and `FlakyModule` now
`export` them, and `DashboardModule` imports both modules. This is the normal
Nest way to share a provider: import the module that owns it instead of
re-declaring the provider (which would create a second instance with its own
dependencies).

## 3. Filters as one SQL fragment

`QaMetricsRepository.runs(scope)` returns a `Prisma.Sql` fragment with the
"runs in scope" definition of the analytics module plus the optional plan,
cycle, release and environment filters. Each query embeds the fragment, so the
execution counts, the trend and the defects raised from runs all agree on the
same set of runs. `Prisma.sql` parameterizes every value; only the bucket name
(a closed enum) is inlined through `truncate()`.

Before building the scope the service resolves every filter id inside the
project (`findPlan`, `findCycle`, ...). An id of another project or tenant
answers 404 — the same answer as a made-up id, so the endpoint cannot be used
to probe for resources.

## 4. Flaky evolution without stored history

S7-F6 stores no derived state, so "how many flaky cases were there last week"
must be recomputed. `evolutionSamples()` uses a window function:

```sql
ROW_NUMBER() OVER (
  PARTITION BY rc."testCaseId", (t."executedAt" >= :from)
  ORDER BY t."executedAt" DESC
)
```

and keeps every result inside the period plus the newest 20 of each case
before it. That is exactly enough history to run `analyzeFlakiness()` on the
results before the end of each bucket. Manual marks are not replayed (debt 70).

## 5. Isolation

All statements filter by `organizationId` and the authorized project and run
inside `PrismaService.runInTransaction`, which sets `app.current_organization`
so PostgreSQL RLS applies under `qaflow_app`. `qa-metrics.int-spec.ts` runs the
API as `qaflow_app` and checks the other tenant, a hidden project, a foreign
filter id and a project-level revoke of `analytics.read`.

## 6. The Web page

`apps/web/src/pages/QaMetricsPage.tsx` (route `/qa-metrics`) reuses the
analytics `Kpi` and `BarList` primitives and plain tables for the trend and the
flaky evolution — no chart library. Every text comes from the `qaMetrics`
catalog in English and Spanish.

## Exercises

1. Add a "skipped rate" card. Which existing field gives it, and should it obey
   the minimum sample?
2. Make the thresholds configurable per project. Where would you store them,
   and how would you keep the documentation of each KPI exact?
3. Replay manual flaky marks in the evolution series using their `createdAt`.
