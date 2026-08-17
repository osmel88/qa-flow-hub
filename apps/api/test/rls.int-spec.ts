import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * The database half of tenant isolation.
 *
 * Every other suite connects as the owner of the tables, which PostgreSQL
 * exempts from Row Level Security, and proves that `TenantAwareRepository`
 * filters correctly. That is the first layer. This suite connects as
 * `qaflow_app` — the role the API actually uses in production — and asks the
 * only question the first layer cannot answer: what happens when a query
 * *forgets* the filter?
 *
 * The answer has to be "nothing", not "someone else's data".
 */
describe('row level security', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let asApp: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;

  const request = injector(() => app);

  /** Same database, connected as the non-owning runtime role. */
  const appRoleUrl = (): string => {
    const url = new URL(
      process.env['TEST_DATABASE_URL'] ??
        'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public',
    );
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  /**
   * Runs `work` with the organization announced, the way the application does:
   * `set_config(..., TRUE)` is transaction-local, so the setting cannot outlive
   * the statement it belongs to and leak into the next borrower of the pooled
   * connection.
   */
  const asOrganization = async <T>(
    organizationId: string | null,
    work: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> =>
    asApp.$transaction(async (tx) => {
      if (organizationId !== null) {
        await tx.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, TRUE)`;
      }
      return work(tx as unknown as PrismaClient);
    });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    asApp = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
    globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLO',
    });

    await request('POST', '/api/v1/requirements', {
      payload: { projectId: acme.projectId, title: 'Acme login', type: 'functional' },
      token: acme.owner.accessToken,
      organizationId: acme.organizationId,
    });
    await request('POST', '/api/v1/requirements', {
      payload: { projectId: globex.projectId, title: 'Globex login', type: 'functional' },
      token: globex.owner.accessToken,
      organizationId: globex.organizationId,
    });
  });

  afterAll(async () => {
    await asApp.$disconnect();
    await prisma.truncateAllTables();
    await app.close();
  });

  it('is not the owner of the tables, so the policies apply to it', async () => {
    const rows = await asApp.$queryRaw<Array<{ current_user: string }>>`SELECT current_user`;

    expect(rows[0]?.current_user).toBe('qaflow_app');
  });

  it('reads nothing at all when no organization was announced', async () => {
    // This is the shape of the bug the layer exists for: a query with no tenant
    // filter. Failing closed means an empty list, never everybody's rows.
    expect(await asApp.requirement.findMany()).toHaveLength(0);
    expect(await asApp.project.findMany()).toHaveLength(0);
    expect(await asApp.auditLog.count()).toBe(0);
  });

  it('reads only its own organization even with no organizationId in the query', async () => {
    const rows = await asOrganization(acme.organizationId, (tx) => tx.requirement.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Acme login');
    expect(rows.every((row) => row.organizationId === acme.organizationId)).toBe(true);
  });

  it('cannot read another organization even when asked for it by id', async () => {
    const stolen = await asOrganization(acme.organizationId, (tx) =>
      tx.requirement.findMany({ where: { organizationId: globex.organizationId } }),
    );
    const byProject = await asOrganization(acme.organizationId, (tx) =>
      tx.project.findFirst({ where: { id: globex.projectId } }),
    );

    expect(stolen).toHaveLength(0);
    expect(byProject).toBeNull();
  });

  it('cannot update or delete another organization rows', async () => {
    const target = await prisma.requirement.findFirstOrThrow({
      where: { organizationId: globex.organizationId },
    });

    const updated = await asOrganization(acme.organizationId, (tx) =>
      tx.requirement.updateMany({
        where: { id: target.id },
        data: { title: 'Owned by nobody' },
      }),
    );
    const deleted = await asOrganization(acme.organizationId, (tx) =>
      tx.requirement.deleteMany({ where: { id: target.id } }),
    );

    expect(updated.count).toBe(0);
    expect(deleted.count).toBe(0);

    // Read back as the owner: the row is untouched, not merely invisible.
    const after = await prisma.requirement.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.title).toBe('Globex login');
  });

  it('cannot write a row belonging to another organization', async () => {
    await expect(
      asOrganization(acme.organizationId, (tx) =>
        tx.requirement.create({
          data: {
            organizationId: globex.organizationId,
            projectId: globex.projectId,
            key: 'GLO-R-99',
            title: 'Planted',
            type: 'functional',
            createdById: acme.owner.userId,
          },
        }),
      ),
    ).rejects.toThrow();

    expect(
      await prisma.requirement.count({ where: { organizationId: globex.organizationId } }),
    ).toBe(1);
  });

  it('cannot rewrite or erase the audit log at all', async () => {
    // Belt and braces: the triggers refuse the operation and this role does not
    // even hold the privilege. Either one alone is a single point of failure.
    await expect(
      asOrganization(acme.organizationId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE audit_logs SET summary = 'nothing happened'`),
      ),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(
      asOrganization(acme.organizationId, (tx) => tx.$executeRawUnsafe(`DELETE FROM audit_logs`)),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(
      asOrganization(acme.organizationId, (tx) => tx.$executeRawUnsafe(`TRUNCATE TABLE audit_logs`)),
    ).rejects.toThrow(/permission denied|append-only/);
  });

  it('cannot change the schema or the policies that constrain it', async () => {
    await expect(
      asApp.$executeRawUnsafe(`ALTER TABLE requirements DISABLE ROW LEVEL SECURITY`),
    ).rejects.toThrow(/must be owner|permission denied/);
    await expect(
      asApp.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`),
    ).rejects.toThrow(/must be owner|permission denied/);
    await expect(asApp.$executeRawUnsafe(`DROP POLICY tenant_isolation ON requirements`)).rejects.toThrow(
      /must be owner|permission denied/,
    );
  });
});
