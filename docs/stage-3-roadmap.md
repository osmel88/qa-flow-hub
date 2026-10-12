# Stage 3 (S3) — Product consolidation on mocks and local services

Stage 2 closed with every external system behind a port and a mock
(`BillingProvider`, `SecretResolver`, the integration connectors). Stage 3
keeps it that way: each phase must be buildable and testable entirely locally,
and real providers are added later without touching domain logic.

Execution rule, unchanged:

> plan with decisions → approval → phase → validation (lint, typecheck, unit,
> integration, build, E2E, `db:migrations:check`) → commit → summary with debt
> → **stop** → explicit approval → next phase.

Hard constraints:

- No real external provider (GitHub, TestRail, Jira, Stripe, secret manager).
- No Redis and no new infrastructure without prior approval.
- Phases are picked from [`commercial-roadmap.md`](commercial-roadmap.md) in
  order, skipping items that need an external service.

## S3-F1 — Import & Export

Commercial roadmap items 1.2 and 1.3: import test cases from CSV and from a
TestRail CSV export file, and export cases, runs and the traceability matrix.

**Status: implemented.** Decisions (approved before implementation):

1. A persisted `ImportJob` (migration `import_jobs`): the dry run stores a
   normalized plan, the commit applies exactly that plan, and the history
   stays.
2. An import creates cases, suites, nested sections (`A > B > C`), steps and
   `verifies` links to **existing** requirements of the same project, from the
   `references` column.
3. Duplicates (same suite, section and normalized title, archived cases
   included) are skipped and reported as warnings; re-importing a file
   creates nothing.
4. CSV only, one row per case with steps on extra rows. No XML or XLSX.
5. New permissions `test_design.import` (qa_lead and above) and `data.export`
   (every role with read access; revocable per project with an override).
6. PDF through printable HTML views and the browser's "Save as PDF"; no
   server-side renderer (ADR 0016).
7. `csv-parse@7.0.3`, exact version, no transitive dependencies.

What shipped:

- `POST /projects/:projectId/imports?format=qaflow_csv|testrail_csv&suiteId|suiteName`
  (multipart, dry run), `GET .../imports`, `GET .../imports/:id`,
  `GET .../imports/limits`, `POST .../imports/:id/commit`.
- File guard (size before parsing, strict UTF-8, BOM, binary signatures,
  UTF-16, NUL), column/record/row/case/step/depth limits, row-by-row issues
  with `{ row, column, code, severity, message }`.
- Atomic commit under `pg_advisory_xact_lock('import:<org>:<project>')`,
  re-resolution inside the transaction, 409 `IMPORT_STALE` if the project
  changed since the dry run, one winner for concurrent commits, case-key
  counter reserved inside the same transaction, jobs expiring after 24 h and
  at most 20 `ready` jobs per project.
- `GET /projects/:projectId/exports/test-cases.csv`,
  `GET /test-runs/:id/export.csv` (from the run snapshots),
  `GET /traceability/matrix/export.csv`; formula neutralization, BOM, safe
  headers, audited with `AuditAction.export`.
- Web: import wizard with the dry-run report, disabled commit while there are
  errors, history; export buttons and printable views gated on
  `data.export`.

Not in this phase: persisting TestRail ids as external references, XML/XLSX,
scheduled or emailed reports, blocking manual case creation in archived
projects (debt 38).

## Related

- [`stage-2-roadmap.md`](stage-2-roadmap.md) — the stage this one builds on
- [`technical-debt.md`](technical-debt.md) — entry 38 for this phase
- [`adr/0016-printable-html-instead-of-server-pdf.md`](adr/0016-printable-html-instead-of-server-pdf.md)
