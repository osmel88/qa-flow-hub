/**
 * Pre-deployment review of the migrations directory:
 *
 *   npm run db:migrations:check -w @qa-flow-hub/api
 *
 * Exits non-zero when a migration that is not yet part of the reviewed history
 * contains a destructive or RLS-weakening statement without an explicit
 * `-- migration-safety: allow <rule>: <reason>` marker, or when the directory
 * layout is wrong. Runs in CI on every push; needs no database.
 *
 * Whether a given database has every migration applied is a different
 * question with its own command, `prisma migrate status`, and the readiness
 * probe answers it for a running instance.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MigrationFinding,
  reviewMigrationLayout,
  reviewMigrationSql,
} from '../src/database/migration-safety';

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

/**
 * Migrations already applied to deployed databases, reviewed when they were
 * written. They are history: rewriting one changes its checksum and is never
 * the fix, so the statement rules apply to everything after this list. A
 * release that ships new migrations appends their names here.
 */
const REVIEWED_HISTORY: readonly string[] = [
  '20260731224751_init',
  '20260816135824_audit_log_append_only',
  '20260816160000_row_level_security',
  '20260831110000_integration_settings',
  '20260901090000_linkable_test_suite',
  '20260913120000_external_reference_project',
  '20260920100000_notifications',
  '20260927100000_attachments_storage',
  '20261004100000_project_permission_overrides',
];

function main(): void {
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, sqlPath: join(MIGRATIONS_DIR, name, 'migration.sql') }));

  const findings: MigrationFinding[] = reviewMigrationLayout(
    migrations.map(({ name, sqlPath }) => ({ name, hasSql: existsSync(sqlPath) })),
    REVIEWED_HISTORY,
  );

  const pendingReview = migrations.filter(
    ({ name, sqlPath }) => !REVIEWED_HISTORY.includes(name) && existsSync(sqlPath),
  );
  for (const { name, sqlPath } of pendingReview) {
    findings.push(...reviewMigrationSql(name, readFileSync(sqlPath, 'utf8')));
  }

  for (const finding of findings) {
    const where = finding.line > 0 ? `:${finding.line}` : '';
    console.error(`✗ ${finding.migration}${where} — ${finding.message}`);
  }

  if (findings.length > 0) {
    console.error(`\n${findings.length} migration safety finding(s).`);
    process.exit(1);
  }

  console.log(
    `✓ ${migrations.length} migrations: ${REVIEWED_HISTORY.length} reviewed history, ` +
      `${pendingReview.length} new, no findings.`,
  );
}

main();
