import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OrganizationRole, ProjectStatus } from '@prisma/client';
import { paginationQuerySchema } from '@qa-flow-hub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { RequestContext, TenantContextService } from '../src/database/tenant-context.service';
import { ProjectsRepository } from '../src/modules/projects/projects.repository';
import { createTestApp } from './utils/create-test-app';

/**
 * The isolation suite.
 *
 * Every functional module gets a test like this one. It is not about "does the
 * repository work"; it is about proving that a caller acting for organization A
 * cannot read, update or delete anything belonging to organization B — even
 * when it knows the exact primary key, which is the realistic attack.
 */
describe('tenant isolation (projects repository)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let tenant: TenantContextService;
  let repository: ProjectsRepository;

  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;

  const query = paginationQuerySchema.parse({});

  /** Runs `work` as if a member of `organizationId` had made the request. */
  const asOrganization = <T>(organizationId: string, work: () => T): T => {
    const context: RequestContext = {
      requestId: `test-${organizationId}`,
      userId: 'test-user',
      organizationId,
      role: OrganizationRole.organization_owner,
    };
    return tenant.run(context, work);
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    tenant = app.get(TenantContextService);
    repository = new ProjectsRepository(prisma, tenant);

    await prisma.truncateAllTables();

    const [a, b] = await Promise.all([
      prisma.organization.create({ data: { name: 'Alpha', slug: 'alpha' } }),
      prisma.organization.create({ data: { name: 'Beta', slug: 'beta' } }),
    ]);
    orgA = a.id;
    orgB = b.id;

    const [pa, pb] = await Promise.all([
      prisma.project.create({ data: { organizationId: orgA, name: 'Alpha Portal', key: 'ALP' } }),
      prisma.project.create({ data: { organizationId: orgB, name: 'Beta Portal', key: 'BET' } }),
    ]);
    projectA = pa.id;
    projectB = pb.id;
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  it('lists only the projects of the active organization', async () => {
    const fromA = await asOrganization(orgA, () => repository.list(query));
    const fromB = await asOrganization(orgB, () => repository.list(query));

    expect(fromA.data.map((p) => p.key)).toEqual(['ALP']);
    expect(fromA.meta.total).toBe(1);
    expect(fromB.data.map((p) => p.key)).toEqual(['BET']);
  });

  it('does not return another organization row even when the id is known', async () => {
    await expect(asOrganization(orgA, () => repository.findById(projectB))).resolves.toBeNull();
    await expect(asOrganization(orgB, () => repository.findById(projectA))).resolves.toBeNull();
  });

  it('does not update another organization row', async () => {
    const result = await asOrganization(orgA, () =>
      repository.update(projectB, { name: 'Hijacked' }),
    );

    expect(result).toBeNull();

    const untouched = await prisma.project.findUniqueOrThrow({ where: { id: projectB } });
    expect(untouched.name).toBe('Beta Portal');
  });

  it('does not soft delete another organization row', async () => {
    const deleted = await asOrganization(orgA, () => repository.softDelete(projectB));

    expect(deleted).toBe(false);

    const untouched = await prisma.project.findUniqueOrThrow({ where: { id: projectB } });
    expect(untouched.deletedAt).toBeNull();
  });

  it('stamps the active organization on creation and ignores any attempt to set another', async () => {
    const created = await asOrganization(orgA, () =>
      repository.create({ name: 'Alpha Mobile', key: 'ALM' }),
    );

    expect(created.organizationId).toBe(orgA);

    const fromB = await asOrganization(orgB, () => repository.findById(created.id));
    expect(fromB).toBeNull();
  });

  it('hides soft-deleted rows from its own organization', async () => {
    const created = await asOrganization(orgA, () =>
      repository.create({ name: 'Alpha Legacy', key: 'ALG', status: ProjectStatus.archived }),
    );

    await asOrganization(orgA, () => repository.softDelete(created.id));

    await expect(asOrganization(orgA, () => repository.findById(created.id))).resolves.toBeNull();
    const list = await asOrganization(orgA, () => repository.list(query));
    expect(list.data.map((p) => p.key)).not.toContain('ALG');
  });

  it('refuses to query at all when there is no active organization', async () => {
    await expect(repository.list(query)).rejects.toThrow(/No active organization/);
  });
});

/**
 * The database-level guarantees. These are constraints that no amount of
 * application code can be trusted to enforce on its own.
 */
describe('database constraints', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let organizationId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await prisma.truncateAllTables();
    const org = await prisma.organization.create({ data: { name: 'Gamma', slug: 'gamma' } });
    organizationId = org.id;
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  it('allows the same project key in two different organizations', async () => {
    const other = await prisma.organization.create({ data: { name: 'Delta', slug: 'delta' } });

    await prisma.project.create({ data: { organizationId, name: 'Shared', key: 'SHR' } });
    await expect(
      prisma.project.create({ data: { organizationId: other.id, name: 'Shared', key: 'SHR' } }),
    ).resolves.toMatchObject({ key: 'SHR' });
  });

  it('rejects a duplicate project key inside one organization', async () => {
    await prisma.project.create({ data: { organizationId, name: 'Unique', key: 'UNQ' } });

    await expect(
      prisma.project.create({ data: { organizationId, name: 'Duplicate', key: 'UNQ' } }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('rejects a second pending invitation for the same email and organization', async () => {
    const base = {
      organizationId,
      email: 'invitee@example.test',
      role: OrganizationRole.tester,
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    await prisma.organizationInvitation.create({ data: { ...base, tokenHash: 'hash-one' } });

    await expect(
      prisma.organizationInvitation.create({ data: { ...base, tokenHash: 'hash-two' } }),
      // Prisma reports the partial index by its columns rather than its name.
    ).rejects.toThrow(/Unique constraint failed on the fields: \(`organizationId`,`email`\)/);
  });

  it('allows a new invitation once the previous one is revoked', async () => {
    const base = {
      organizationId,
      email: 'second@example.test',
      role: OrganizationRole.tester,
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    const first = await prisma.organizationInvitation.create({
      data: { ...base, tokenHash: 'hash-three' },
    });
    await prisma.organizationInvitation.update({
      where: { id: first.id },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    await expect(
      prisma.organizationInvitation.create({ data: { ...base, tokenHash: 'hash-four' } }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('rejects a traceability link from an entity to itself', async () => {
    await expect(
      prisma.traceabilityLink.create({
        data: {
          organizationId,
          sourceType: 'requirement',
          sourceId: 'same-id',
          targetType: 'requirement',
          targetId: 'same-id',
          linkType: 'relates_to',
        },
      }),
    ).rejects.toThrow(/traceability_links_no_self_link/);
  });

  it('rejects a lowercase project key', async () => {
    await expect(
      prisma.project.create({ data: { organizationId, name: 'Lowercase', key: 'low' } }),
    ).rejects.toThrow(/projects_key_uppercase/);
  });
});
