/**
 * Gives the runtime role a password so the API can log in.
 *
 * The migration creates `qaflow_app` with `NOLOGIN` and no password, because a
 * password inside a migration is a committed secret and everybody who clones the
 * repository would share it. This script does the part that cannot be committed,
 * reading the value from the environment:
 *
 *   APP_DATABASE_PASSWORD=... npm run db:grant-app-role -w @qa-flow-hub/api
 *
 * It connects as the owner (`DATABASE_MIGRATION_URL`) and is idempotent, so it
 * is safe to run on every deployment — which is the point: rotating the password
 * is this command plus a new `DATABASE_URL`.
 */
import { PrismaClient } from '@prisma/client';

const ROLE = 'qaflow_app';

/**
 * The Prisma CLI reads `.env` on its own; a plain script does not.
 *
 * Restoring the previous values afterwards is not ceremony: the test harness and
 * CI pass a *different* database in the environment, and a local `.env` winning
 * would point this at the wrong cluster with the wrong password — the kind of
 * mistake that only shows up as an authentication failure much later.
 */
function loadDotEnvWithoutOverriding(): void {
  const fromEnvironment = { ...process.env };

  try {
    process.loadEnvFile();
  } catch {
    // No local .env: the environment is expected to carry the values.
    return;
  }

  Object.assign(process.env, fromEnvironment);
}

async function main(): Promise<void> {
  loadDotEnvWithoutOverriding();

  const password = process.env['APP_DATABASE_PASSWORD'];

  if (password === undefined || password.length < 8) {
    throw new Error('APP_DATABASE_PASSWORD is required and must be at least 8 characters');
  }

  const prisma = new PrismaClient();

  try {
    // `ALTER ROLE` takes a literal, not a bound parameter, so the statement has
    // to be built as text. It is built by PostgreSQL's own `format` with `%L`
    // rather than by string concatenation here: quoting a password correctly is
    // exactly the kind of thing to delegate to the server.
    const [built] = await prisma.$queryRaw<Array<{ statement: string }>>`
      SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${ROLE}, ${password}) AS statement
    `;

    if (built === undefined) {
      throw new Error('Could not build the ALTER ROLE statement');
    }

    await prisma.$executeRawUnsafe(built.statement);

    console.log(`Role ${ROLE} can now log in.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
