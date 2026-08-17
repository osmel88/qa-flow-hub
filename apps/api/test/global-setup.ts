import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';

/** Throwaway credential for the RLS suite. Only ever valid on the test database. */
const APP_PASSWORD = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';

/**
 * Brings the test database up to the current migration state once, before any
 * suite runs, and gives the runtime role a password.
 *
 * `migrate deploy` and not `migrate dev`: it applies the committed migrations
 * and nothing else. If a migration is missing or malformed, the tests fail here
 * with a clear message instead of failing later as "column does not exist".
 *
 * The suites themselves connect as the **owner**, which Row Level Security does
 * not apply to. That is on purpose: they exist to prove the repository layer
 * isolates tenants, and several of them set up two organizations at once, which
 * no single tenant connection can do. The database layer gets its own suite,
 * `rls.int-spec.ts`, connecting as `qaflow_app`.
 */
export function setup(): void {
  const env = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_MIGRATION_URL: TEST_DATABASE_URL,
    APP_DATABASE_PASSWORD: APP_PASSWORD,
  };
  const cwd = resolve(__dirname, '..');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd, env, stdio: 'inherit' });
  execFileSync('npx', ['tsx', 'prisma/grant-app-role.ts'], { cwd, env, stdio: 'inherit' });
}
