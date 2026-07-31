import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';

/**
 * Brings the test database up to the current migration state once, before any
 * suite runs.
 *
 * `migrate deploy` and not `migrate dev`: it applies the committed migrations
 * and nothing else. If a migration is missing or malformed, the tests fail here
 * with a clear message instead of failing later as "column does not exist".
 */
export function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
