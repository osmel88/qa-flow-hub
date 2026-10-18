import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DashboardSummary, OrganizationDashboard } from '@qa-flow-hub/shared';
import { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Project visibility: below organization admin a member discovers a project
 * only through a grant. Every scenario compares what a member without a grant
 * gets for a real project with what anybody gets for an id that never existed —
 * the two answers must be indistinguishable.
 */
describe('project visibility', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;
  let hidden: Hidden;

  const request = injector(() => app);
  const MADE_UP = 'cmvisibility000000000000';

  interface Hidden {
    projectId: string;
    requirementId: string;
    suiteId: string;
    caseId: string;
    runId: string;
    defectId: string;
  }

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
    ...(payload === undefined ? {} : { payload }),
  });
  const asOwner = (payload?: object) => as(workspace.owner, payload);

  const created = async (response: Promise<LightMyRequestResponse>): Promise<string> => {
    const result = await response;
    expect(result.statusCode, result.body).toBe(201);
    return result.json().id;
  };

  const createHiddenProject = async (): Promise<Hidden> => {
    const projectId = await created(
      request('POST', '/api/v1/projects', asOwner({ name: 'Secret Launch', key: 'SEC' })),
    );
    const requirementId = await created(
      request('POST', '/api/v1/requirements', asOwner({ projectId, title: 'Secret requirement' })),
    );
    const suiteId = await created(
      request('POST', '/api/v1/test-suites', asOwner({ projectId, name: 'Secret suite' })),
    );
    const caseId = await created(
      request('POST', '/api/v1/test-cases', asOwner({ suiteId, title: 'Secret case' })),
    );
    const runId = await created(
      request(
        'POST',
        '/api/v1/test-runs',
        asOwner({ projectId, name: 'Secret run', selection: { testCaseIds: [caseId] } }),
      ),
    );
    const defectId = await created(
      request('POST', '/api/v1/defects', asOwner({ projectId, title: 'Secret defect' })),
    );
    return { projectId, requirementId, suiteId, caseId, runId, defectId };
  };

  const giveAccess = (account: TestAccount, projectId: string, role: string | null = null) =>
    request(
      'POST',
      `/api/v1/projects/${projectId}/members`,
      asOwner({ userId: account.userId, role }),
    );

  const listedNames = async (account: TestAccount, query = '', organizationId?: string) => {
    const response = await request(
      'GET',
      `/api/v1/projects${query}`,
      as(account, undefined, organizationId),
    );
    expect(response.statusCode, response.body).toBe(200);
    return {
      names: response.json().data.map((project: { name: string }) => project.name) as string[],
      total: response.json().meta.total as number,
    };
  };

  /** Every read that names a project, by the project id. */
  const projectUrls = (projectId: string) => [
    `/api/v1/projects/${projectId}`,
    `/api/v1/projects/${projectId}/members`,
    `/api/v1/projects/${projectId}/permissions/me`,
    `/api/v1/projects/${projectId}/dashboard/summary`,
    `/api/v1/projects/${projectId}/dashboard/coverage`,
    `/api/v1/projects/${projectId}/imports`,
    `/api/v1/projects/${projectId}/exports/test-cases.csv`,
    `/api/v1/dashboard?projectId=${projectId}`,
    `/api/v1/requirements?projectId=${projectId}`,
    `/api/v1/test-suites?projectId=${projectId}`,
    `/api/v1/test-cases?projectId=${projectId}`,
    `/api/v1/test-runs?projectId=${projectId}`,
    `/api/v1/defects?projectId=${projectId}`,
    `/api/v1/traceability/matrix?projectId=${projectId}`,
    `/api/v1/traceability/matrix/export.csv?projectId=${projectId}`,
  ];

  /** Every read that reaches a project through one of its entities. */
  const entityUrls = (ids: Omit<Hidden, 'projectId'>) => [
    `/api/v1/requirements/${ids.requirementId}`,
    `/api/v1/test-suites/${ids.suiteId}/sections`,
    `/api/v1/test-cases/${ids.caseId}`,
    `/api/v1/test-runs/${ids.runId}`,
    `/api/v1/test-runs/${ids.runId}/export.csv`,
    `/api/v1/defects/${ids.defectId}`,
    `/api/v1/traceability/links?entityType=requirement&entityId=${ids.requirementId}`,
  ];

  const madeUpIds = {
    requirementId: MADE_UP,
    suiteId: MADE_UP,
    caseId: MADE_UP,
    runId: MADE_UP,
    defectId: MADE_UP,
  };

  /** Status and error, without the request id: what a client could compare. */
  const answer = async (account: TestAccount, url: string, organizationId?: string) => {
    const response = await request('GET', url, as(account, undefined, organizationId));
    if (response.statusCode >= 400) {
      const error = response.json().error as { code: string; message: string };
      return { status: response.statusCode, code: error.code, message: error.message };
    }
    const body = response.headers['content-type']?.toString().includes('json')
      ? response.json<{ data?: unknown[] }>()
      : null;
    return {
      status: response.statusCode,
      rows: Array.isArray(body?.data) ? body.data.length : null,
    };
  };

  const expectIndistinguishable = async (account: TestAccount, organizationId?: string) => {
    const real = projectUrls(hidden.projectId);
    const fake = projectUrls(MADE_UP);
    for (const [index, url] of real.entries()) {
      const forReal = await answer(account, url, organizationId);
      expect(forReal, url).toEqual(await answer(account, fake[index] ?? '', organizationId));
    }
    const realEntities = entityUrls(hidden);
    const fakeEntities = entityUrls(madeUpIds);
    for (const [index, url] of realEntities.entries()) {
      expect(await answer(account, url, organizationId), url).toEqual(
        await answer(account, fakeEntities[index] ?? '', organizationId),
      );
    }
  };

  const organizationDashboard = async (account: TestAccount) => {
    const response = await request('GET', '/api/v1/dashboard/organization', as(account));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<OrganizationDashboard>();
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
    hidden = await createHiddenProject();
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe.each(['project_manager', 'qa_lead', 'tester', 'viewer'])(
    'a %s without a grant',
    (role) => {
      it('does not find the project in the list, a search or its count', async () => {
        const member = await workspace.addMember(role);

        expect(await listedNames(member)).toEqual({ names: ['Website'], total: 1 });
        expect(await listedNames(member, '?search=secret')).toEqual({ names: [], total: 0 });
        expect(await listedNames(member, '?search=SEC')).toEqual({ names: [], total: 0 });
      });

      it('gets the same answer for its id as for an id that never existed', async () => {
        const member = await workspace.addMember(role);
        await expectIndistinguishable(member);
      });

      it('sees neither its name nor its numbers on a dashboard', async () => {
        const member = await workspace.addMember(role);

        const dashboard = await organizationDashboard(member);
        expect(dashboard.health.projects).toBe(1);
        expect(dashboard.projects.map((row) => row.name)).toEqual(['Website']);
        expect(JSON.stringify(dashboard)).not.toContain('Secret');
        expect(JSON.stringify(dashboard)).not.toContain(hidden.projectId);

        const legacy = await request('GET', '/api/v1/dashboard', as(member));
        const summary = legacy.json<DashboardSummary>();
        expect(summary.requirements.total).toBe(0);
        expect(summary.defects.open).toBe(0);
        expect(summary.testCases.total).toBe(0);
        expect(summary.projects).toEqual({ active: 1, archived: 0 });
        expect(summary.runs.recent).toEqual([]);
        expect(JSON.stringify(summary)).not.toContain('Secret');
      });
    },
  );

  it('shows the project to a member as soon as they are granted it, with their organization role', async () => {
    const tester = await workspace.addMember('tester');
    expect((await giveAccess(tester, hidden.projectId)).statusCode).toBe(201);

    expect((await listedNames(tester)).names.sort()).toEqual(['Secret Launch', 'Website']);
    const read = await request('GET', `/api/v1/projects/${hidden.projectId}`, as(tester));
    expect(read.statusCode).toBe(200);
    const mine = await request(
      'GET',
      `/api/v1/projects/${hidden.projectId}/permissions/me`,
      as(tester),
    );
    expect(mine.json()).toMatchObject({ hasAccess: true, effectiveRole: 'tester' });
    expect((await organizationDashboard(tester)).health.projects).toBe(2);
    const requirement = await request(
      'GET',
      `/api/v1/requirements/${hidden.requirementId}`,
      as(tester),
    );
    expect(requirement.statusCode).toBe(200);
  });

  it('hides the project again on revocation, on the very next request with the same token', async () => {
    const lead = await workspace.addMember('qa_lead');
    await giveAccess(lead, hidden.projectId, 'project_manager');
    expect((await listedNames(lead)).total).toBe(2);

    const revoked = await request(
      'DELETE',
      `/api/v1/projects/${hidden.projectId}/members/${lead.userId}`,
      asOwner(),
    );
    expect(revoked.statusCode).toBe(204);

    expect(await listedNames(lead)).toEqual({ names: ['Website'], total: 1 });
    await expectIndistinguishable(lead);
    expect(
      await prisma.projectPermissionOverride.count({
        where: { projectId: hidden.projectId, userId: lead.userId },
      }),
    ).toBe(0);
  });

  it('drops the overrides with the grant, so access given again starts clean', async () => {
    const tester = await workspace.addMember('tester');
    await giveAccess(tester, hidden.projectId);
    const override = await request(
      'PUT',
      `/api/v1/projects/${hidden.projectId}/permissions/members/${tester.userId}`,
      asOwner({ overrides: [{ permission: 'requirements.write', effect: 'grant' }] }),
    );
    expect(override.statusCode, override.body).toBe(200);
    await request(
      'DELETE',
      `/api/v1/projects/${hidden.projectId}/members/${tester.userId}`,
      asOwner(),
    );

    await giveAccess(tester, hidden.projectId);
    const write = await request(
      'POST',
      '/api/v1/requirements',
      as(tester, { projectId: hidden.projectId, title: 'Leftover override' }),
    );
    expect(write.statusCode).toBe(403);
  });

  it('refuses overrides for a member who cannot see the project', async () => {
    const tester = await workspace.addMember('tester');
    const response = await request(
      'PUT',
      `/api/v1/projects/${hidden.projectId}/permissions/members/${tester.userId}`,
      asOwner({ overrides: [{ permission: 'requirements.write', effect: 'grant' }] }),
    );
    expect(response.statusCode).toBe(409);
    expect(await prisma.projectPermissionOverride.count()).toBe(0);
  });

  it('brings a reinvited member back without the projects they used to see', async () => {
    const member = await workspace.addMember('tester', 'returning');
    await giveAccess(member, hidden.projectId, 'qa_lead');
    expect((await listedNames(member)).total).toBe(2);

    await request('DELETE', `/api/v1/organizations/current/members/${member.userId}`, asOwner());
    const invitation = await request(
      'POST',
      '/api/v1/organizations/current/invitations',
      asOwner({ email: member.email, role: 'tester' }),
    );
    const accepted = await request('POST', '/api/v1/organizations/invitations/accept', {
      payload: { token: invitation.json().token },
      token: member.accessToken,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    expect(await listedNames(member)).toEqual({ names: [], total: 0 });
    await expectIndistinguishable(member);
  });

  it.each(['organization_owner', 'organization_admin'])(
    'lets an %s see every project of the organization without a grant',
    async (role) => {
      const account =
        role === 'organization_owner' ? workspace.owner : await workspace.addMember(role);

      expect((await listedNames(account)).names.sort()).toEqual(['Secret Launch', 'Website']);
      expect((await organizationDashboard(account)).health.projects).toBe(2);
      for (const url of [
        ...projectUrls(hidden.projectId).slice(0, 2),
        ...entityUrls(hidden).slice(0, 4),
      ]) {
        const response = await request('GET', url, as(account));
        expect(response.statusCode, `${url} ${response.body}`).toBe(200);
      }
    },
  );

  it('applies the same rules to an archived project', async () => {
    const granted = await workspace.addMember('viewer', 'granted');
    const outsider = await workspace.addMember('viewer', 'outsider');
    await giveAccess(granted, hidden.projectId);
    const archived = await request(
      'POST',
      `/api/v1/projects/${hidden.projectId}/archive`,
      asOwner(),
    );
    expect(archived.statusCode, archived.body).toBe(200);

    expect(await listedNames(outsider, '?status=archived')).toEqual({ names: [], total: 0 });
    expect(await listedNames(granted, '?status=archived')).toEqual({
      names: ['Secret Launch'],
      total: 1,
    });
    await expectIndistinguishable(outsider);
    const read = await request('GET', `/api/v1/projects/${hidden.projectId}`, as(granted));
    expect(read.statusCode).toBe(200);
  });

  it('keeps every project of another organization out of reach, even for its owner', async () => {
    const stranger = await createWorkspace(app, {
      emailPrefix: 'stranger',
      slug: 'globex',
      projectKey: 'GLO',
    });

    expect(await listedNames(stranger.owner, '', stranger.organizationId)).toEqual({
      names: ['Website'],
      total: 1,
    });
    expect(
      (await listedNames(stranger.owner, '?search=secret', stranger.organizationId)).total,
    ).toBe(0);
    await expectIndistinguishable(stranger.owner, stranger.organizationId);
  });

  it('scopes visibility to the organization in the header when a member switches tenant', async () => {
    const member = await workspace.addMember('tester', 'switcher');
    await giveAccess(member, hidden.projectId);
    const globex = await createWorkspace(app, {
      emailPrefix: 'globex',
      slug: 'globex',
      projectKey: 'GLO',
    });
    const invitation = await request('POST', '/api/v1/organizations/current/invitations', {
      payload: { email: member.email, role: 'tester' },
      token: globex.owner.accessToken,
      organizationId: globex.organizationId,
    });
    await request('POST', '/api/v1/organizations/invitations/accept', {
      payload: { token: invitation.json().token },
      token: member.accessToken,
    });

    expect((await listedNames(member)).total).toBe(2);
    // Same token, other tenant: no grant there, and nothing from the first one.
    expect(await listedNames(member, '', globex.organizationId)).toEqual({ names: [], total: 0 });
    await expectIndistinguishable(member, globex.organizationId);
  });

  it('refuses to assign work to somebody who cannot see the project', async () => {
    const outsider = await workspace.addMember('tester', 'outsider');
    const before = await prisma.notification.count();

    const defect = await request(
      'PATCH',
      `/api/v1/defects/${hidden.defectId}`,
      asOwner({ assigneeId: outsider.userId }),
    );
    expect(defect.statusCode).toBe(400);
    expect(defect.json().error.message).toContain('no access to this project');

    const run = await request(
      'POST',
      `/api/v1/test-runs/${hidden.runId}/assignments`,
      asOwner({
        runCaseIds: (await request('GET', `/api/v1/test-runs/${hidden.runId}/cases`, asOwner()))
          .json()
          .data.map((runCase: { id: string }) => runCase.id),
        assignedToId: outsider.userId,
      }),
    );
    expect(run.statusCode).toBe(400);
    expect(await prisma.notification.count()).toBe(before);

    await giveAccess(outsider, hidden.projectId);
    const allowed = await request(
      'PATCH',
      `/api/v1/defects/${hidden.defectId}`,
      asOwner({ assigneeId: outsider.userId }),
    );
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('does not let a link reveal the other end in a project the caller cannot see', async () => {
    const tester = await workspace.addMember('tester');
    const suite = await created(
      request(
        'POST',
        '/api/v1/test-suites',
        asOwner({ projectId: workspace.projectId, name: 'Visible suite' }),
      ),
    );
    const ownCase = await created(
      request('POST', '/api/v1/test-cases', asOwner({ suiteId: suite, title: 'Visible case' })),
    );
    const link = await request(
      'POST',
      '/api/v1/traceability/links',
      asOwner({
        sourceType: 'requirement',
        sourceId: hidden.requirementId,
        targetType: 'test_case',
        targetId: ownCase,
        linkType: 'verifies',
      }),
    );
    expect(link.statusCode, link.body).toBe(201);

    const fromVisible = await request(
      'GET',
      `/api/v1/traceability/links?entityType=test_case&entityId=${ownCase}`,
      as(tester),
    );
    expect(fromVisible.statusCode).toBe(200);
    expect(fromVisible.body).not.toContain(hidden.requirementId);
    expect(fromVisible.body).not.toContain('Secret');
  });
});
