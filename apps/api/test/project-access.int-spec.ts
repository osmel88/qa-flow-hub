import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OrganizationRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';

const PASSWORD = 'Str0ngPassword!';

/**
 * Project-scoped roles.
 *
 * The bug these tests exist for is the one a customer with two teams finds on
 * their first day: somebody hired to test the mobile app could also edit the
 * web app, because the role lived on the organization and nowhere else. So the
 * assertions are deliberately about *asymmetry* — the same person, the same
 * token, two projects, two answers.
 */
describe('project-scoped roles', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: { payload?: object; token?: string; organizationId?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.organizationId === undefined
          ? {}
          : { 'x-organization-id': options.organizationId }),
      },
    });

  interface Account {
    userId: string;
    email: string;
    accessToken: string;
  }

  const registerAccount = async (email: string): Promise<Account> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, fullName: 'Test Person' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { userId: body.user.id, email: body.user.email, accessToken: body.accessToken };
  };

  /** Adds an existing account to an organization with a role, without email. */
  const addMember = (organizationId: string, account: Account, role: OrganizationRole) =>
    prisma.organizationMember.create({
      data: { organizationId, userId: account.userId, role, status: 'active' },
    });

  const createOrganization = async (account: Account, slug: string): Promise<string> => {
    const response = await request('POST', '/api/v1/organizations', {
      payload: { name: `Org ${slug}`, slug },
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  };

  const createProject = async (
    account: Account,
    organizationId: string,
    key: string,
  ): Promise<string> => {
    const response = await request('POST', '/api/v1/projects', {
      payload: { name: `Project ${key}`, key },
      token: account.accessToken,
      organizationId,
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  };

  const grant = (
    actor: Account,
    organizationId: string,
    projectId: string,
    userId: string,
    role: OrganizationRole,
  ) =>
    request('POST', `/api/v1/projects/${projectId}/members`, {
      payload: { userId, role },
      token: actor.accessToken,
      organizationId,
    });

  /** A write that only the author roles may perform. */
  const createSuite = (account: Account, organizationId: string, projectId: string, name: string) =>
    request('POST', '/api/v1/test-suites', {
      payload: { projectId, name },
      token: account.accessToken,
      organizationId,
    });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('a grant applies to one project only', () => {
    it('lets an organization tester author suites in the project where they lead QA, and nowhere else', async () => {
      const owner = await registerAccount('owner@example.test');
      const tester = await registerAccount('tester@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, tester, OrganizationRole.tester);

      const mobile = await createProject(owner, organizationId, 'MOB');
      const web = await createProject(owner, organizationId, 'WEB');

      // Before the grant the tester cannot author anywhere.
      expect((await createSuite(tester, organizationId, mobile, 'Smoke')).statusCode).toBe(403);

      expect(
        (await grant(owner, organizationId, mobile, tester.userId, OrganizationRole.qa_lead))
          .statusCode,
      ).toBe(201);

      expect((await createSuite(tester, organizationId, mobile, 'Smoke')).statusCode).toBe(201);
      // Same person, same token, other project: still a tester there.
      expect((await createSuite(tester, organizationId, web, 'Smoke')).statusCode).toBe(403);
    });

    it('narrows an organization qa_lead to a viewer in one project', async () => {
      const owner = await registerAccount('owner@example.test');
      const lead = await registerAccount('lead@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, lead, OrganizationRole.qa_lead);

      const mobile = await createProject(owner, organizationId, 'MOB');
      const web = await createProject(owner, organizationId, 'WEB');

      await grant(owner, organizationId, mobile, lead.userId, OrganizationRole.viewer);

      expect((await createSuite(lead, organizationId, mobile, 'Smoke')).statusCode).toBe(403);
      expect((await createSuite(lead, organizationId, web, 'Smoke')).statusCode).toBe(201);
    });

    it('applies to a route whose project is only known through the entity', async () => {
      const owner = await registerAccount('owner@example.test');
      const lead = await registerAccount('lead@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, lead, OrganizationRole.qa_lead);
      const projectId = await createProject(owner, organizationId, 'WEB');

      const suite = await createSuite(lead, organizationId, projectId, 'Smoke');
      const suiteId = suite.json().id;

      await grant(owner, organizationId, projectId, lead.userId, OrganizationRole.viewer);

      // The suite id says nothing about a project; the service resolves it.
      const renamed = await request('PATCH', `/api/v1/test-suites/${suiteId}`, {
        payload: { name: 'Renamed' },
        token: lead.accessToken,
        organizationId,
      });

      expect(renamed.statusCode).toBe(403);
      expect(renamed.json().error.message).toContain('in this project');
    });

    it('leaves reading alone: a narrowed member still sees the project', async () => {
      const owner = await registerAccount('owner@example.test');
      const lead = await registerAccount('lead@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, lead, OrganizationRole.qa_lead);
      const projectId = await createProject(owner, organizationId, 'WEB');

      await grant(owner, organizationId, projectId, lead.userId, OrganizationRole.viewer);

      const read = await request('GET', `/api/v1/projects/${projectId}`, {
        token: lead.accessToken,
        organizationId,
      });

      expect(read.statusCode).toBe(200);
    });

    it('returns the member to their organization role when the grant is revoked', async () => {
      const owner = await registerAccount('owner@example.test');
      const lead = await registerAccount('lead@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, lead, OrganizationRole.qa_lead);
      const projectId = await createProject(owner, organizationId, 'WEB');

      await grant(owner, organizationId, projectId, lead.userId, OrganizationRole.viewer);
      expect((await createSuite(lead, organizationId, projectId, 'Smoke')).statusCode).toBe(403);

      const revoked = await request(
        'DELETE',
        `/api/v1/projects/${projectId}/members/${lead.userId}`,
        { token: owner.accessToken, organizationId },
      );
      expect(revoked.statusCode).toBe(204);

      expect((await createSuite(lead, organizationId, projectId, 'Smoke')).statusCode).toBe(201);
    });
  });

  describe('granting is itself an authorization decision', () => {
    it('refuses a grant more powerful than the granter', async () => {
      const owner = await registerAccount('owner@example.test');
      const manager = await registerAccount('manager@example.test');
      const tester = await registerAccount('tester@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, manager, OrganizationRole.project_manager);
      await addMember(organizationId, tester, OrganizationRole.tester);
      const projectId = await createProject(owner, organizationId, 'WEB');

      const response = await grant(
        manager,
        organizationId,
        projectId,
        tester.userId,
        OrganizationRole.organization_admin,
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain('more powerful than your own');
    });

    it('refuses to change your own project role', async () => {
      const owner = await registerAccount('owner@example.test');
      const manager = await registerAccount('manager@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, manager, OrganizationRole.project_manager);
      const projectId = await createProject(owner, organizationId, 'WEB');

      const response = await grant(
        manager,
        organizationId,
        projectId,
        manager.userId,
        OrganizationRole.qa_lead,
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain('your own role');
    });

    it('refuses to scope down an organization owner', async () => {
      const owner = await registerAccount('owner@example.test');
      const admin = await registerAccount('admin@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, admin, OrganizationRole.organization_admin);
      const projectId = await createProject(owner, organizationId, 'WEB');

      const response = await grant(
        admin,
        organizationId,
        projectId,
        owner.userId,
        OrganizationRole.viewer,
      );

      expect(response.statusCode).toBe(403);
    });

    it('refuses a grant to somebody who is not in the organization', async () => {
      const owner = await registerAccount('owner@example.test');
      const stranger = await registerAccount('stranger@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const projectId = await createProject(owner, organizationId, 'WEB');

      const response = await grant(
        owner,
        organizationId,
        projectId,
        stranger.userId,
        OrganizationRole.tester,
      );

      expect(response.statusCode).toBe(404);
    });

    it('answers 404 for a project that belongs to another organization', async () => {
      const owner = await registerAccount('owner@example.test');
      const outsider = await registerAccount('outsider@example.test');
      const mine = await createOrganization(owner, 'acme');
      const theirs = await createOrganization(outsider, 'globex');
      const theirProject = await createProject(outsider, theirs, 'WEB');
      const member = await registerAccount('member@example.test');
      await addMember(mine, member, OrganizationRole.tester);

      const response = await grant(
        owner,
        mine,
        theirProject,
        member.userId,
        OrganizationRole.qa_lead,
      );

      // Not "forbidden": telling the caller that the id exists elsewhere is
      // itself a leak of another tenant's data.
      expect(response.statusCode).toBe(404);
    });

    it('records the grant in the audit trail', async () => {
      const owner = await registerAccount('owner@example.test');
      const tester = await registerAccount('tester@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, tester, OrganizationRole.tester);
      const projectId = await createProject(owner, organizationId, 'WEB');

      await grant(owner, organizationId, projectId, tester.userId, OrganizationRole.qa_lead);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId, entityType: 'ProjectMember' },
      });
      expect(entry.action).toBe('role_change');
    });
  });

  describe('the members view', () => {
    it('shows the effective role of everybody in the organization', async () => {
      const owner = await registerAccount('owner@example.test');
      const tester = await registerAccount('tester@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await addMember(organizationId, tester, OrganizationRole.tester);
      const projectId = await createProject(owner, organizationId, 'WEB');

      await grant(owner, organizationId, projectId, tester.userId, OrganizationRole.qa_lead);

      const response = await request('GET', `/api/v1/projects/${projectId}/members`, {
        token: tester.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(200);
      const rows = response.json().data as Array<Record<string, unknown>>;
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: tester.userId,
            organizationRole: 'tester',
            projectRole: 'qa_lead',
            effectiveRole: 'qa_lead',
          }),
          // The owner has no grant and needs none: owners are never narrowed.
          expect.objectContaining({
            userId: owner.userId,
            projectRole: null,
            effectiveRole: 'organization_owner',
          }),
        ]),
      );
    });
  });
});
