import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  DashboardSummary,
  MatrixRow,
  MemberPermissionsView,
  PermissionOverrideInput,
  ProjectCoverageView,
} from '@qa-flow-hub/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { SessionsRepository } from '../src/modules/auth/sessions.repository';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Regressions for the access-control and consistency findings raised on PR #1.
 * Every scenario goes through the public API with real tokens: the property
 * under test is what the backend answers when the client is bypassed.
 */
describe('PR #1 security regressions', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;
  let suiteId: string;

  const request = injector(() => app);

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
  });
  const asOwner = (payload?: object) => as(workspace.owner, payload);

  const createProject = async (key: string): Promise<string> => {
    const response = await request(
      'POST',
      '/api/v1/projects',
      asOwner({ name: `Project ${key}`, key }),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id;
  };

  const createSuite = async (projectId: string): Promise<string> =>
    (await request('POST', '/api/v1/test-suites', asOwner({ projectId, name: 'Checkout' }))).json()
      .id;

  const createCase = async (payload: object = {}, suite = suiteId): Promise<string> => {
    const response = await request(
      'POST',
      '/api/v1/test-cases',
      asOwner({ suiteId: suite, title: `Case ${Math.random()}`, ...payload }),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id;
  };

  const createRequirement = async (projectId = workspace.projectId): Promise<string> =>
    (
      await request(
        'POST',
        '/api/v1/requirements',
        asOwner({ projectId, title: `Requirement ${Math.random()}` }),
      )
    ).json().id;

  const verifies = async (requirementId: string, testCaseId: string): Promise<string> => {
    const response = await request(
      'POST',
      '/api/v1/traceability/links',
      asOwner({
        sourceType: 'requirement',
        sourceId: requirementId,
        targetType: 'test_case',
        targetId: testCaseId,
        linkType: 'verifies',
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id;
  };

  const executeCase = async (
    testCaseId: string,
    status: string,
    projectId = workspace.projectId,
  ): Promise<{ runId: string; runCaseId: string; resultId: string }> => {
    const run = await request(
      'POST',
      '/api/v1/test-runs',
      asOwner({ projectId, name: `Run ${Math.random()}`, selection: { testCaseIds: [testCaseId] } }),
    );
    expect(run.statusCode, run.body).toBe(201);
    const runId: string = run.json().id;
    const runCaseId: string = (
      await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())
    ).json().data[0].id;
    const result = await request(
      'POST',
      `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
      asOwner({ status }),
    );
    expect(result.statusCode, result.body).toBe(201);
    return { runId, runCaseId, resultId: result.json().id };
  };

  const setOverrides = async (
    target: TestAccount,
    overrides: PermissionOverrideInput[],
    projectId = workspace.projectId,
  ): Promise<void> => {
    const response = await request(
      'PUT',
      `/api/v1/projects/${projectId}/permissions/members/${target.userId}`,
      asOwner({ overrides }),
    );
    expect(response.statusCode, response.body).toBe(200);
  };

  const rowFor = async (requirementId: string): Promise<MatrixRow> => {
    const matrix = await request(
      'GET',
      `/api/v1/traceability/matrix?projectId=${workspace.projectId}`,
      asOwner(),
    );
    const row = matrix
      .json()
      .rows.find((candidate: MatrixRow) => candidate.requirementId === requirementId);
    if (row === undefined) {
      throw new Error(`No matrix row for ${requirementId}`);
    }
    return row;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
    suiteId = await createSuite(workspace.projectId);
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('concurrent refresh', () => {
    const asBodyClient = { 'x-refresh-transport': 'body' };
    const register = async (email: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'Str0ngPassword!', fullName: 'Race Condition' },
        headers: asBodyClient,
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ refreshToken: string; user: { id: string } }>();
    };
    const refresh = (refreshToken: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken },
        headers: asBodyClient,
      });

    it('consumes a session once, however many rotations race for it', async () => {
      const { user } = await register('race.repository@example.test');
      const sessions = app.get(SessionsRepository);
      const [previous] = await sessions.listActiveForUser(user.id);
      if (previous === undefined) {
        throw new Error('The registration did not open a session');
      }

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          sessions.rotate(previous, `${'f'.repeat(63)}${index}`, {
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ),
      );

      const winners = outcomes.filter((outcome) => outcome !== null);
      expect(winners).toHaveLength(1);
      const live = await prisma.session.findMany({ where: { userId: user.id, revokedAt: null } });
      expect(live.map((session) => session.id)).toEqual([winners[0]?.id]);
      const consumed = await prisma.session.findUniqueOrThrow({ where: { id: previous.id } });
      expect(consumed.replacedById).toBe(winners[0]?.id);
    });

    it('fails only the losing request and leaves the winner its session', async () => {
      const registered = await register('race.api@example.test');
      const sessions = app.get(SessionsRepository);
      const [stale] = await sessions.listActiveForUser(registered.user.id);

      const winner = await refresh(registered.refreshToken);
      expect(winner.statusCode).toBe(200);

      // The loser read the session before the winner committed: replay that read.
      const spy = vi.spyOn(sessions, 'findByTokenHash').mockResolvedValueOnce(stale ?? null);
      const loser = await refresh(registered.refreshToken);
      spy.mockRestore();

      expect(loser.statusCode).toBe(401);
      expect(loser.json().error.code).not.toBe('TOKEN_REUSE_DETECTED');
      expect(
        await prisma.session.count({ where: { userId: registered.user.id, revokedAt: null } }),
      ).toBe(1);
      expect((await refresh(winner.json().refreshToken)).statusCode).toBe(200);
    });

    it('still treats a later replay of the consumed token as reuse', async () => {
      const registered = await register('race.replay@example.test');
      expect((await refresh(registered.refreshToken)).statusCode).toBe(200);

      const replayed = await refresh(registered.refreshToken);

      expect(replayed.statusCode).toBe(401);
      expect(replayed.json().error.code).toBe('TOKEN_REUSE_DETECTED');
      expect(
        await prisma.session.count({ where: { userId: registered.user.id, revokedAt: null } }),
      ).toBe(0);
    });
  });

  describe('project-scoped lists', () => {
    const READ_REVOKES: PermissionOverrideInput[] = [
      { permission: 'requirements.read', effect: 'revoke' },
      { permission: 'test_design.read', effect: 'revoke' },
      { permission: 'testruns.read', effect: 'revoke' },
      { permission: 'defects.read', effect: 'revoke' },
      { permission: 'traceability.read', effect: 'revoke' },
      { permission: 'analytics.read', effect: 'revoke' },
    ];

    const listUrls = (projectId: string) => [
      `/api/v1/requirements?projectId=${projectId}&page=2&pageSize=1`,
      `/api/v1/test-suites?projectId=${projectId}`,
      `/api/v1/test-cases?projectId=${projectId}&page=2&pageSize=1`,
      `/api/v1/test-runs?projectId=${projectId}&page=2&pageSize=1`,
      `/api/v1/defects?projectId=${projectId}&page=2&pageSize=1`,
      `/api/v1/traceability/matrix?projectId=${projectId}`,
      `/api/v1/dashboard?projectId=${projectId}`,
    ];

    it('refuses every list, on any page, once the project read is revoked', async () => {
      const viewer = await workspace.addMember('viewer');
      const other = await createProject('OTH');
      for (const url of listUrls(workspace.projectId)) {
        const before = await request('GET', url, as(viewer));
        expect(before.statusCode, `${url} ${before.body}`).toBe(200);
      }

      await setOverrides(viewer, READ_REVOKES);

      for (const url of listUrls(workspace.projectId)) {
        const after = await request('GET', url, as(viewer));
        expect(after.statusCode, `${url} ${after.body}`).toBe(403);
      }
      // The revoke is per project: the sibling project still answers.
      for (const url of listUrls(other)) {
        const sibling = await request('GET', url, as(viewer));
        expect(sibling.statusCode, `${url} ${sibling.body}`).toBe(200);
      }
    });

    it('rejects a project-scoped list that names no project', async () => {
      for (const path of [
        '/requirements',
        '/test-suites',
        '/test-cases',
        '/test-runs',
        '/defects',
        '/traceability/matrix',
      ]) {
        const response = await request('GET', `/api/v1${path}`, asOwner());
        expect(response.statusCode, `${path} ${response.body}`).toBe(400);
      }
    });

    it('pages through every case for a reader and none for another tenant', async () => {
      for (let index = 0; index < 3; index += 1) {
        await createCase();
      }
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const pages = await Promise.all(
        [1, 2, 3].map(async (page) =>
          (
            await request(
              'GET',
              `/api/v1/test-cases?projectId=${workspace.projectId}&page=${page}&pageSize=1`,
              asOwner(),
            )
          ).json(),
        ),
      );
      expect(pages.map((page) => page.data.length)).toEqual([1, 1, 1]);
      expect(new Set(pages.map((page) => page.data[0].id)).size).toBe(3);
      expect(pages[0].meta).toMatchObject({ total: 3, totalPages: 3 });

      const foreign = await request(
        'GET',
        `/api/v1/test-cases?projectId=${workspace.projectId}&page=2&pageSize=1`,
        as(stranger.owner, undefined, stranger.organizationId),
      );
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().data).toEqual([]);
    });

    it('refuses to duplicate a case of a project whose design write was revoked', async () => {
      const lead = await workspace.addMember('qa_lead');
      const caseId = await createCase();
      await setOverrides(lead, [{ permission: 'test_design.write', effect: 'revoke' }]);
      const before = await prisma.testCase.count();

      const response = await request(
        'POST',
        `/api/v1/test-cases/${caseId}/duplicate`,
        as(lead, {}),
      );

      expect(response.statusCode).toBe(403);
      expect(await prisma.testCase.count()).toBe(before);
    });
  });

  describe('legacy dashboard', () => {
    it('sums only the projects the caller may analyse', async () => {
      const viewer = await workspace.addMember('viewer');
      const other = await createProject('OTH');
      await createRequirement(workspace.projectId);
      await createRequirement(other);
      await createRequirement(other);

      const before = await request('GET', '/api/v1/dashboard', as(viewer));
      expect(before.json<DashboardSummary>().requirements.total).toBe(3);

      await setOverrides(viewer, [{ permission: 'analytics.read', effect: 'revoke' }]);

      const after = await request('GET', '/api/v1/dashboard', as(viewer));
      expect(after.statusCode, after.body).toBe(200);
      expect(after.json<DashboardSummary>().requirements.total).toBe(2);
      expect(after.json<DashboardSummary>().projects.active).toBe(1);
    });

    it('answers 404 for another tenant project', async () => {
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      const response = await request(
        'GET',
        `/api/v1/dashboard?projectId=${workspace.projectId}`,
        as(stranger.owner, undefined, stranger.organizationId),
      );
      expect(response.statusCode).toBe(404);
    });
  });

  describe('coverage counts only live cases of the same project', () => {
    const coverage = async () => {
      const modern = await request(
        'GET',
        `/api/v1/projects/${workspace.projectId}/dashboard/coverage`,
        asOwner(),
      );
      const legacy = await request(
        'GET',
        `/api/v1/dashboard?projectId=${workspace.projectId}`,
        asOwner(),
      );
      return {
        modern: modern.json<ProjectCoverageView>().coverage.covered,
        legacy: legacy.json<DashboardSummary>().coverage.covered,
      };
    };

    it('drops an archived case and counts it again once restored', async () => {
      const requirementId = await createRequirement();
      const caseId = await createCase();
      await verifies(requirementId, caseId);
      expect(await coverage()).toEqual({ modern: 1, legacy: 1 });

      await request('POST', `/api/v1/test-cases/${caseId}/archive`, asOwner());
      expect(await coverage()).toEqual({ modern: 0, legacy: 0 });

      await request('POST', `/api/v1/test-cases/${caseId}/restore`, asOwner());
      expect(await coverage()).toEqual({ modern: 1, legacy: 1 });
    });

    it('drops a deleted case even if its link survived', async () => {
      const requirementId = await createRequirement();
      const caseId = await createCase();
      await verifies(requirementId, caseId);
      // A link left behind by a writer that bypassed the service cleanup.
      await prisma.testCase.update({ where: { id: caseId }, data: { deletedAt: new Date() } });

      expect(await coverage()).toEqual({ modern: 0, legacy: 0 });
    });

    it("never counts a case of another project as this project's coverage", async () => {
      const other = await createProject('OTH');
      const foreignCase = await createCase({}, await createSuite(other));
      const requirementId = await createRequirement();
      await prisma.traceabilityLink.create({
        data: {
          organizationId: workspace.organizationId,
          sourceType: 'requirement',
          sourceId: requirementId,
          targetType: 'test_case',
          targetId: foreignCase,
          linkType: 'verifies',
          createdById: workspace.owner.userId,
        },
      });

      expect(await coverage()).toEqual({ modern: 0, legacy: 0 });
    });
  });

  describe('defect origin', () => {
    it("refuses a result of another project and accepts the project's own", async () => {
      const other = await createProject('OTH');
      const foreignCase = await createCase({}, await createSuite(other));
      const foreign = await executeCase(foreignCase, 'failed', other);
      const ownCase = await createCase();
      const own = await executeCase(ownCase, 'failed');

      const stolen = await request(
        'POST',
        '/api/v1/defects',
        asOwner({
          projectId: workspace.projectId,
          title: 'Claims a foreign result',
          testResultId: foreign.resultId,
        }),
      );
      expect(stolen.statusCode).toBe(404);
      expect(await prisma.defect.count()).toBe(0);

      const raised = await request(
        'POST',
        '/api/v1/defects',
        asOwner({
          projectId: workspace.projectId,
          title: 'From our own result',
          testResultId: own.resultId,
        }),
      );
      expect(raised.statusCode, raised.body).toBe(201);
      expect(raised.json()).toMatchObject({ testRunId: own.runId, testCaseId: ownCase });
    });
  });

  describe('traceability links', () => {
    const links = (account: TestAccount, requirementId: string, organizationId?: string) =>
      request(
        'GET',
        `/api/v1/traceability/links?entityType=requirement&entityId=${requirementId}`,
        as(account, undefined, organizationId),
      );

    it('authorizes the requested end and hides ends in projects the caller cannot read', async () => {
      const tester = await workspace.addMember('tester');
      const other = await createProject('OTH');
      const requirementId = await createRequirement();
      const ownCase = await createCase();
      const foreignCase = await createCase({}, await createSuite(other));
      await verifies(requirementId, ownCase);
      await verifies(requirementId, foreignCase);

      const full = await links(tester, requirementId);
      expect(full.statusCode, full.body).toBe(200);
      expect(full.json()).toHaveLength(2);

      await setOverrides(tester, [{ permission: 'traceability.read', effect: 'revoke' }], other);
      const filtered = await links(tester, requirementId);
      expect(filtered.json().map((link: { targetId: string }) => link.targetId)).toEqual([
        ownCase,
      ]);

      await setOverrides(tester, [{ permission: 'traceability.read', effect: 'revoke' }]);
      expect((await links(tester, requirementId)).statusCode).toBe(403);
    });

    it('answers 404 to another tenant and for a deleted end', async () => {
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      const requirementId = await createRequirement();
      await verifies(requirementId, await createCase());

      expect((await links(stranger.owner, requirementId, stranger.organizationId)).statusCode).toBe(
        404,
      );

      await request('DELETE', `/api/v1/requirements/${requirementId}`, asOwner());
      expect((await links(workspace.owner, requirementId)).statusCode).toBe(404);
    });
  });

  describe('removed and reinvited members', () => {
    const invite = async (email: string, role: string, organizationId = workspace.organizationId) =>
      (
        await request('POST', '/api/v1/organizations/current/invitations', {
          payload: { email, role },
          token: workspace.owner.accessToken,
          organizationId,
        })
      ).json().token as string;

    it('come back with the invitation role and none of their old project grants', async () => {
      const member = await workspace.addMember('tester', 'returning');
      const grant = await request(
        'POST',
        `/api/v1/projects/${workspace.projectId}/members`,
        asOwner({ userId: member.userId, role: 'project_manager' }),
      );
      expect(grant.statusCode, grant.body).toBe(201);
      await setOverrides(member, [{ permission: 'integrations.manage', effect: 'grant' }]);

      const removed = await request(
        'DELETE',
        `/api/v1/organizations/current/members/${member.userId}`,
        asOwner(),
      );
      expect(removed.statusCode).toBe(204);
      const scope = { organizationId: workspace.organizationId, userId: member.userId };
      expect(await prisma.projectMember.count({ where: scope })).toBe(0);
      expect(await prisma.projectPermissionOverride.count({ where: scope })).toBe(0);

      const accepted = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: await invite(member.email, 'viewer') },
        token: member.accessToken,
      });
      expect(accepted.statusCode, accepted.body).toBe(200);

      const mine = await request(
        'GET',
        `/api/v1/projects/${workspace.projectId}/permissions/me`,
        as(member),
      );
      const view = mine.json<MemberPermissionsView>();
      const granted = view.permissions.filter((entry) => entry.granted);
      expect(granted.map((entry) => entry.permission)).not.toContain('integrations.manage');
      expect(granted.map((entry) => entry.permission)).not.toContain('requirements.write');
      expect(view.permissions.every((entry) => entry.source !== 'override')).toBe(true);
      const write = await request(
        'POST',
        '/api/v1/requirements',
        as(member, { projectId: workspace.projectId, title: 'Should not be allowed' }),
      );
      expect(write.statusCode).toBe(403);
    });

    it("keeps the member's grants in another organization untouched", async () => {
      const member = await workspace.addMember('tester', 'shared');
      const globex = await createWorkspace(app, {
        emailPrefix: 'globex-owner',
        slug: 'globex',
        projectKey: 'GLO',
      });
      const token = (
        await request('POST', '/api/v1/organizations/current/invitations', {
          payload: { email: member.email, role: 'tester' },
          token: globex.owner.accessToken,
          organizationId: globex.organizationId,
        })
      ).json().token;
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token },
        token: member.accessToken,
      });
      const elsewhere = await request(
        'PUT',
        `/api/v1/projects/${globex.projectId}/permissions/members/${member.userId}`,
        {
          payload: { overrides: [{ permission: 'testruns.create', effect: 'grant' }] },
          token: globex.owner.accessToken,
          organizationId: globex.organizationId,
        },
      );
      expect(elsewhere.statusCode, elsewhere.body).toBe(200);
      await setOverrides(member, [{ permission: 'testruns.create', effect: 'grant' }]);

      await request(
        'DELETE',
        `/api/v1/organizations/current/members/${member.userId}`,
        asOwner(),
      );

      expect(
        await prisma.projectPermissionOverride.count({ where: { userId: member.userId } }),
      ).toBe(1);
      expect(
        await prisma.projectPermissionOverride.count({
          where: { userId: member.userId, organizationId: globex.organizationId },
        }),
      ).toBe(1);
    });
  });

  describe('run snapshots and verification', () => {
    it('freezes the step inputs into the run', async () => {
      const caseId = await createCase({
        steps: [{ action: 'Enter the card', data: '4111 1111 1111 1111', expectedResult: 'Accepted' }],
      });
      const { runId } = await executeCase(caseId, 'passed');
      await request(
        'POST',
        `/api/v1/test-cases/${caseId}/steps`,
        asOwner({ steps: [{ action: 'Changed', data: 'other data' }] }),
      );

      const [runCase] = (await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())).json()
        .data;
      expect(runCase.snapshot.steps).toEqual([
        {
          position: 1,
          action: 'Enter the card',
          expectedResult: 'Accepted',
          data: '4111 1111 1111 1111',
        },
      ]);
    });

    it('lets a deleted run stop deciding whether a requirement is verified', async () => {
      const requirementId = await createRequirement();
      const caseId = await createCase();
      await verifies(requirementId, caseId);
      await executeCase(caseId, 'passed');
      expect((await rowFor(requirementId)).verified).toBe(true);

      const failing = await executeCase(caseId, 'failed');
      expect((await rowFor(requirementId)).verified).toBe(false);

      const deleted = await request('DELETE', `/api/v1/test-runs/${failing.runId}`, asOwner());
      expect(deleted.statusCode, deleted.body).toBe(204);
      const row = await rowFor(requirementId);
      expect(row.verified).toBe(true);
      expect(row.cases[0]?.lastStatus).toBe('passed');
    });
  });

  describe('S2-F9 close review', () => {
    it("keeps another project's cases out of the matrix", async () => {
      const other = await createProject('OTH');
      const foreignCase = await createCase({}, await createSuite(other));
      const requirementId = await createRequirement();
      await verifies(requirementId, foreignCase);

      const row = await rowFor(requirementId);
      expect(row.cases).toEqual([]);
      expect(row.covered).toBe(false);
    });

    it('refuses to link a defect to a requirement outside its project', async () => {
      const other = await createProject('OTH');
      const foreignRequirement = await createRequirement(other);
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      const strangerRequirement = (
        await request(
          'POST',
          '/api/v1/requirements',
          as(
            stranger.owner,
            { projectId: stranger.projectId, title: 'Foreign tenant requirement' },
            stranger.organizationId,
          ),
        )
      ).json().id;

      for (const requirementId of [foreignRequirement, strangerRequirement, 'does-not-exist']) {
        const refused = await request(
          'POST',
          '/api/v1/defects',
          asOwner({ projectId: workspace.projectId, title: 'Cross link', requirementIds: [requirementId] }),
        );
        expect(refused.statusCode, refused.body).toBe(400);
      }
      expect(await prisma.defect.count({ where: { organizationId: workspace.organizationId } })).toBe(0);
      expect(
        await prisma.traceabilityLink.count({ where: { sourceType: 'defect' } }),
      ).toBe(0);

      const ownRequirement = await createRequirement();
      const raised = await request(
        'POST',
        '/api/v1/defects',
        asOwner({ projectId: workspace.projectId, title: 'Own link', requirementIds: [ownRequirement] }),
      );
      expect(raised.statusCode, raised.body).toBe(201);
    });

    it("applies the project role, not the organization role, to someone else's assigned case", async () => {
      const narrowed = await workspace.addMember('qa_lead', 'narrowed');
      const raised = await workspace.addMember('tester', 'raised');
      for (const [account, role] of [
        [narrowed, 'tester'],
        [raised, 'qa_lead'],
      ] as const) {
        const grant = await request(
          'POST',
          `/api/v1/projects/${workspace.projectId}/members`,
          asOwner({ userId: account.userId, role }),
        );
        expect(grant.statusCode, grant.body).toBe(201);
      }

      const caseId = await createCase();
      const run = await request(
        'POST',
        '/api/v1/test-runs',
        asOwner({ projectId: workspace.projectId, name: 'Assigned', selection: { testCaseIds: [caseId] } }),
      );
      const runId: string = run.json().id;
      const runCaseId: string = (
        await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())
      ).json().data[0].id;
      await request(
        'POST',
        `/api/v1/test-runs/${runId}/assignments`,
        asOwner({ runCaseIds: [runCaseId], assignedToId: workspace.owner.userId }),
      );
      const record = (account: TestAccount) =>
        request(
          'POST',
          `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
          as(account, { status: 'passed' }),
        );

      expect((await record(narrowed)).statusCode).toBe(403);
      const filled = await record(raised);
      expect(filled.statusCode, filled.body).toBe(201);
    });
  });
});
