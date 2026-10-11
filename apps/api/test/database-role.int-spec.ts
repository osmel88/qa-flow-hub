import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseRoleProblems, inspectDatabaseRole } from '../src/database/database-role.inspector';

const PASSWORD = 'role_probe_test_pw';

/**
 * The boot-time guard against a connection Row Level Security does not apply
 * to, checked against real PostgreSQL roles. Ownership and the ability to
 * assume a privileged role are both reached through membership, which the role
 * attributes alone do not show.
 */
describe('database role inspection (integration)', () => {
  const ownerUrl =
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  const clients: PrismaClient[] = [];

  const connectAs = (role: string, password: string): PrismaClient => {
    const url = new URL(ownerUrl);
    url.username = role;
    url.password = password;
    const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    clients.push(client);
    return client;
  };

  let tableOwner = '';

  beforeAll(async () => {
    const [row] = await owner.$queryRaw<Array<{ tableowner: string }>>`
      SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'projects'
    `;
    tableOwner = row?.tableowner ?? '';
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS role_probe_member`);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS role_probe_bypass_member`);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS role_probe_bypass`);
    await owner.$executeRawUnsafe(
      `CREATE ROLE role_probe_member LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`,
    );
    await owner.$executeRawUnsafe(`GRANT "${tableOwner}" TO role_probe_member`);
    await owner.$executeRawUnsafe(`CREATE ROLE role_probe_bypass NOLOGIN BYPASSRLS`);
    await owner.$executeRawUnsafe(
      `CREATE ROLE role_probe_bypass_member LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`,
    );
    await owner.$executeRawUnsafe(`GRANT role_probe_bypass TO role_probe_bypass_member`);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS role_probe_member`);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS role_probe_bypass_member`);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS role_probe_bypass`);
    await owner.$disconnect();
  });

  it('accepts the runtime role', async () => {
    const runtime = connectAs(
      'qaflow_app',
      process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test',
    );

    expect(databaseRoleProblems(await inspectDatabaseRole(runtime))).toEqual([]);
  });

  it('flags the owner of the tables', async () => {
    expect(databaseRoleProblems(await inspectDatabaseRole(owner))).toContain(
      'owns application tables',
    );
  });

  it('flags a role that owns the tables only through membership of the owner', async () => {
    const member = connectAs('role_probe_member', PASSWORD);

    expect(databaseRoleProblems(await inspectDatabaseRole(member))).toContain(
      'owns application tables',
    );
  });

  it('flags a role that can assume a BYPASSRLS role', async () => {
    const member = connectAs('role_probe_bypass_member', PASSWORD);

    expect(databaseRoleProblems(await inspectDatabaseRole(member))).toEqual([
      'can assume a superuser or BYPASSRLS role',
    ]);
  });
});
