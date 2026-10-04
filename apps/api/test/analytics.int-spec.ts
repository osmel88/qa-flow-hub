import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * S2-F9 analytics: every formula against data whose answer is known, the
 * window semantics, and the boundaries — another organization, another
 * project, a revoked `analytics.read`.
 */
describe('analytics dashboards', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
  });
  const asOwner = (payload?: object) => as(workspace.owner, payload);

  const projectDashboard = async (part: string, query = '', projectId = workspace.projectId) => {
    const response = await request(
      'GET',
      `/api/v1/projects/${projectId}/dashboard/${part}${query}`,
      asOwner(),
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };

  const organizationDashboard = async (query = '') => {
    const response = await request('GET', `/api/v1/dashboard/organization${query}`, asOwner());
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };

  const createCases = async (count: number, projectId = workspace.projectId): Promise<string[]> => {
    const suiteId = (
      await request('POST', '/api/v1/test-suites', asOwner({ projectId, name: `Suite ${count}` }))
    ).json().id;
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const created = await request(
        'POST',
        '/api/v1/test-cases',
        asOwner({ suiteId, title: `Case number ${index}` }),
      );
      ids.push(created.json().id);
    }
    return ids;
  };

  const createRun = async (
    name: string,
    testCaseIds: string[],
    options: { milestone?: string; projectId?: string } = {},
  ): Promise<{ id: string; runCaseIds: string[] }> => {
    const run = await request(
      'POST',
      '/api/v1/test-runs',
      asOwner({
        projectId: options.projectId ?? workspace.projectId,
        name,
        ...(options.milestone === undefined ? {} : { milestone: options.milestone }),
        selection: { testCaseIds },
      }),
    );
    expect(run.statusCode, run.body).toBe(201);
    const id: string = run.json().id;
    const cases = (await request('GET', `/api/v1/test-runs/${id}/cases?pageSize=100`, asOwner()))
      .json()
      .data.map((runCase: { id: string }) => runCase.id);
    return { id, runCaseIds: cases };
  };

  const record = async (runId: string, runCaseId: string, status: string) => {
    const response = await request(
      'POST',
      `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
      asOwner({ status }),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };

  const createRequirement = async (
    title: string,
    priority = 'medium',
    projectId = workspace.projectId,
  ) =>
    (await request('POST', '/api/v1/requirements', asOwner({ projectId, title, priority }))).json();

  const link = (requirementId: string, testCaseId: string) =>
    request(
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

  const createDefect = async (
    title: string,
    severity: string,
    priority = 'medium',
    projectId = workspace.projectId,
  ) =>
    (
      await request('POST', '/api/v1/defects', asOwner({ projectId, title, severity, priority }))
    ).json();

  const moveDefect = async (id: string, ...statuses: string[]) => {
    for (const status of statuses) {
      const response = await request('POST', `/api/v1/defects/${id}/status`, asOwner({ status }));
      expect(response.statusCode, response.body).toBe(200);
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('window', () => {
    it('stamps every response with its period and the moment it was computed', async () => {
      const before = Date.now();
      const parts = ['summary', 'test-results', 'coverage', 'defects', 'trends'];
      const responses = await Promise.all(parts.map((part) => projectDashboard(part)));
      const organization = await organizationDashboard();

      for (const body of [...responses, organization]) {
        expect(body.period.bucket).toBe('day');
        const from = Date.parse(body.period.from);
        const to = Date.parse(body.period.to);
        expect(to - from).toBe(30 * 24 * 60 * 60 * 1000);
        expect(Date.parse(body.computedAt)).toBeGreaterThanOrEqual(before);
      }
    });

    it('honours an explicit window and refuses an invalid one', async () => {
      const body = await projectDashboard(
        'trends',
        '?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z&bucket=week',
      );
      const inverted = await request(
        'GET',
        `/api/v1/projects/${workspace.projectId}/dashboard/summary?from=2026-02-01&to=2026-01-01`,
        asOwner(),
      );
      const tooLong = await request(
        'GET',
        `/api/v1/dashboard/organization?from=2020-01-01&to=2026-01-01`,
        asOwner(),
      );

      expect(body.period).toEqual({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-03-01T00:00:00.000Z',
        bucket: 'week',
      });
      // 2025-12-29 is the Monday of the week containing January 1st.
      expect(body.points[0].bucketStart).toBe('2025-12-29T00:00:00.000Z');
      expect(body.points.at(-1).bucketEnd).toBe('2026-03-01T00:00:00.000Z');
      expect(inverted.statusCode).toBe(400);
      expect(tooLong.statusCode).toBe(400);
    });
  });

  describe('project KPIs', () => {
    it('reports null rates, not zero, for a project with no data', async () => {
      const summary = await projectDashboard('summary');

      expect(summary.execution).toMatchObject({
        planned: 0,
        executed: 0,
        passRate: null,
        progress: null,
      });
      expect(summary.coverage).toEqual({
        requirements: 0,
        covered: 0,
        uncovered: 0,
        percentage: null,
      });
      expect(summary.defects).toEqual({
        open: 0,
        openCritical: 0,
        createdInPeriod: 0,
        closedInPeriod: 0,
        perExecutedCase: null,
      });
      expect(summary.meanTimeToResolve).toEqual({ hours: null, sampleSize: 0 });
    });

    it('computes pass, failed, blocked, skipped and untested from the latest status', async () => {
      const cases = await createCases(6);
      const run = await createRun('Release 1.0', cases, { milestone: '1.0' });
      const [a, b, c, d, e] = run.runCaseIds as [string, string, string, string, string];
      // A retest replaces the verdict: the first `failed` on `a` must not count.
      await record(run.id, a, 'failed');
      await record(run.id, a, 'passed');
      await record(run.id, b, 'passed');
      await record(run.id, c, 'failed');
      await record(run.id, d, 'blocked');
      await record(run.id, e, 'skipped');

      const summary = await projectDashboard('summary');

      expect(summary.execution).toEqual({
        counts: { untested: 1, passed: 2, failed: 1, blocked: 1, skipped: 1 },
        planned: 6,
        executed: 5,
        pending: 1,
        verdicts: 4,
        passRate: 50,
        failedRate: 25,
        blockedRate: 25,
        skippedRate: 16.7,
        untestedRate: 16.7,
        progress: 83.3,
      });
    });

    it('leaves aborted runs and runs completed before the window out of scope', async () => {
      const cases = await createCases(2);
      const live = await createRun('Live', [cases[0] as string]);
      const aborted = await createRun('Aborted', [cases[1] as string]);
      const old = await createRun('Old', [cases[1] as string]);
      await record(live.id, live.runCaseIds[0] as string, 'passed');
      await record(old.id, old.runCaseIds[0] as string, 'failed');
      await request('POST', `/api/v1/test-runs/${aborted.id}/start`, asOwner());
      expect(
        (await request('POST', `/api/v1/test-runs/${aborted.id}/abort`, asOwner())).statusCode,
      ).toBe(200);
      await prisma.testRun.update({
        where: { id: old.id },
        data: {
          status: 'completed',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          completedAt: new Date('2025-01-02T00:00:00Z'),
        },
      });

      const summary = await projectDashboard('summary');
      const results = await projectDashboard('test-results');

      expect(summary.execution.counts).toEqual({
        untested: 0,
        passed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
      });
      expect(results.runs.map((run: { name: string }) => run.name)).toEqual(['Live']);
    });

    it('breaks execution down per run and per milestone, with defects per executed case', async () => {
      const cases = await createCases(3);
      const first = await createRun('Sprint A', cases, { milestone: '1.0' });
      const second = await createRun('Sprint B', [cases[0] as string], { milestone: '1.0' });
      const loose = await createRun('Exploratory', [cases[1] as string]);
      await record(first.id, first.runCaseIds[0] as string, 'passed');
      await record(first.id, first.runCaseIds[1] as string, 'failed');
      await record(second.id, second.runCaseIds[0] as string, 'passed');
      const defect = await createDefect('Checkout breaks', 'major');
      await prisma.defect.update({ where: { id: defect.id }, data: { testRunId: first.id } });

      const view = await projectDashboard('test-results');
      const summary = await projectDashboard('summary');

      const sprintA = view.runs.find((run: { name: string }) => run.name === 'Sprint A');
      expect(sprintA).toMatchObject({
        milestone: '1.0',
        defects: 1,
        defectsPerExecutedCase: 0.5,
        execution: { planned: 3, executed: 2, passRate: 50, progress: 66.7 },
      });
      expect(view.milestones).toEqual([
        expect.objectContaining({
          milestone: '1.0',
          runs: 2,
          execution: expect.objectContaining({ planned: 4, passRate: 66.7 }),
        }),
        expect.objectContaining({
          milestone: null,
          runs: 1,
          execution: expect.objectContaining({ planned: 1, passRate: null }),
        }),
      ]);
      expect(loose.runCaseIds).toHaveLength(1);
      // One defect from a run in scope over three executed cases.
      expect(summary.defects.perExecutedCase).toBe(0.33);
    });

    it('measures requirement → test case coverage and lists what is uncovered', async () => {
      const [caseId] = (await createCases(1)) as [string];
      const covered = await createRequirement('Pay by card', 'high');
      await createRequirement('Refund an order', 'critical');
      await createRequirement('Export invoices', 'low');
      const obsolete = await createRequirement('Fax the receipt', 'critical');
      await prisma.requirement.update({ where: { id: obsolete.id }, data: { status: 'obsolete' } });
      await link(covered.id, caseId);

      const view = await projectDashboard('coverage');
      const summary = await projectDashboard('summary');

      expect(view.coverage).toEqual({
        requirements: 3,
        covered: 1,
        uncovered: 2,
        percentage: 33.3,
      });
      expect(summary.coverage).toEqual(view.coverage);
      expect(view.uncoveredRequirements.map((row: { title: string }) => row.title)).toEqual([
        'Refund an order',
        'Export invoices',
      ]);
      expect(view.byPriority).toEqual([
        { priority: 'critical', requirements: 1, covered: 0, uncovered: 1, percentage: 0 },
        { priority: 'high', requirements: 1, covered: 1, uncovered: 0, percentage: 100 },
        { priority: 'medium', requirements: 0, covered: 0, uncovered: 0, percentage: null },
        { priority: 'low', requirements: 1, covered: 0, uncovered: 1, percentage: 0 },
      ]);
    });

    it('splits defects by severity, priority and status, and times their resolution', async () => {
      await createDefect('Crash on pay', 'blocker', 'critical');
      await createDefect('Wrong total', 'critical', 'high');
      await createDefect('Typo', 'trivial', 'low');
      const fixed = await createDefect('Slow search', 'major', 'medium');
      const rejected = await createDefect('Works as designed', 'minor', 'low');
      await moveDefect(fixed.id, 'in_progress', 'resolved', 'closed');
      await moveDefect(rejected.id, 'rejected');
      const resolvedAt = new Date();
      await prisma.defect.update({
        where: { id: fixed.id },
        data: { createdAt: new Date(resolvedAt.getTime() - 10 * 60 * 60 * 1000), resolvedAt },
      });

      const view = await projectDashboard('defects');

      expect(view).toMatchObject({
        open: 3,
        closed: 2,
        openCritical: 2,
        bySeverity: { blocker: 1, critical: 1, major: 0, minor: 0, trivial: 1 },
        byPriority: { critical: 1, high: 1, medium: 0, low: 1 },
        byStatus: { open: 3, closed: 1, rejected: 1, resolved: 0 },
        closedInPeriod: 2,
        meanTimeToResolve: { hours: 10, sampleSize: 1 },
      });
      // `fixed` was backdated 10 hours, still inside the 30-day window.
      expect(view.createdInPeriod).toBe(5);
    });

    it('compares the pass rate with the previous window of the same length', async () => {
      const cases = await createCases(2);
      const current = await createRun('Now', [cases[0] as string]);
      await record(current.id, current.runCaseIds[0] as string, 'passed');
      const earlier = await createRun('Earlier', [cases[1] as string]);
      await record(earlier.id, earlier.runCaseIds[0] as string, 'failed');
      await prisma.testRun.update({
        where: { id: earlier.id },
        data: {
          status: 'completed',
          createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          completedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000),
        },
      });

      const summary = await projectDashboard('summary');

      expect(summary.comparison.passRate).toEqual({ current: 100, previous: 0, delta: 100 });
    });
  });

  describe('trends', () => {
    it('buckets results, coverage and defects by day with running totals', async () => {
      const window = '?from=2026-03-01T00:00:00Z&to=2026-03-04T00:00:00Z&bucket=day';
      const [caseA, caseB] = (await createCases(2)) as [string, string];
      const run = await createRun('Trend run', [caseA, caseB]);
      const passed = await record(run.id, run.runCaseIds[0] as string, 'passed');
      const failed = await record(run.id, run.runCaseIds[1] as string, 'failed');
      await prisma.testResult.update({
        where: { id: passed.id },
        data: { executedAt: new Date('2026-03-01T10:00:00Z') },
      });
      await prisma.testResult.update({
        where: { id: failed.id },
        data: { executedAt: new Date('2026-03-03T10:00:00Z') },
      });

      const before = await createRequirement('Existed before the window');
      const during = await createRequirement('Added on day two');
      await prisma.requirement.update({
        where: { id: before.id },
        data: { createdAt: new Date('2026-02-01T00:00:00Z') },
      });
      await prisma.requirement.update({
        where: { id: during.id },
        data: { createdAt: new Date('2026-03-02T09:00:00Z') },
      });
      await link(before.id, caseA);
      await prisma.traceabilityLink.updateMany({
        where: { sourceId: before.id },
        data: { createdAt: new Date('2026-03-03T08:00:00Z') },
      });

      const old = await createDefect('Open since February', 'major');
      const fresh = await createDefect('Found on day one', 'minor');
      await prisma.defect.update({
        where: { id: old.id },
        data: { createdAt: new Date('2026-02-10T00:00:00Z') },
      });
      await prisma.defect.update({
        where: { id: fresh.id },
        data: {
          createdAt: new Date('2026-03-01T12:00:00Z'),
          status: 'closed',
          closedAt: new Date('2026-03-02T12:00:00Z'),
        },
      });

      const { points } = await projectDashboard('trends', window);

      expect(points).toEqual([
        {
          bucketStart: '2026-03-01T00:00:00.000Z',
          bucketEnd: '2026-03-02T00:00:00.000Z',
          results: 1,
          passRate: 100,
          coverage: 0,
          defectsCreated: 1,
          defectsClosed: 0,
          defectsOpen: 2,
        },
        {
          bucketStart: '2026-03-02T00:00:00.000Z',
          bucketEnd: '2026-03-03T00:00:00.000Z',
          results: 0,
          passRate: null,
          coverage: 0,
          defectsCreated: 0,
          defectsClosed: 1,
          defectsOpen: 1,
        },
        {
          bucketStart: '2026-03-03T00:00:00.000Z',
          bucketEnd: '2026-03-04T00:00:00.000Z',
          results: 1,
          passRate: 0,
          coverage: 50,
          defectsCreated: 0,
          defectsClosed: 0,
          defectsOpen: 1,
        },
      ]);
    });
  });

  describe('organization dashboard', () => {
    it('ranks projects by failures and coverage and lists recent activity', async () => {
      const mobile = (
        await request('POST', '/api/v1/projects', asOwner({ name: 'Mobile app', key: 'MOB' }))
      ).json();
      const webCases = await createCases(2);
      const mobileCases = await createCases(1, mobile.id);
      const webRun = await createRun('Web run', webCases);
      const mobileRun = await createRun('Mobile run', mobileCases, { projectId: mobile.id });
      await record(webRun.id, webRun.runCaseIds[0] as string, 'failed');
      await record(webRun.id, webRun.runCaseIds[1] as string, 'failed');
      await record(mobileRun.id, mobileRun.runCaseIds[0] as string, 'passed');
      const webRequirement = await createRequirement('Web login');
      await createRequirement('Mobile login', 'medium', mobile.id);
      await link(webRequirement.id, webCases[0] as string);
      await createDefect('Crash on launch', 'blocker', 'critical', mobile.id);

      const dashboard = await organizationDashboard();

      expect(dashboard.health).toMatchObject({
        projects: 2,
        openDefects: 1,
        openCritical: 1,
        execution: { planned: 3, executed: 3, passRate: 33.3 },
        coverage: { requirements: 2, covered: 1, percentage: 50 },
      });
      expect(dashboard.mostFailures).toEqual([
        { projectId: workspace.projectId, key: 'WEB', name: expect.any(String), value: 2 },
      ]);
      expect(
        dashboard.leastCoverage.map((row: { key: string; value: number }) => [row.key, row.value]),
      ).toEqual([
        ['MOB', 0],
        ['WEB', 100],
      ]);
      expect(dashboard.projects).toHaveLength(2);
      expect(dashboard.trends.length).toBeGreaterThanOrEqual(30);
      expect(dashboard.recentActivity[0]).toMatchObject({
        kind: 'defect',
        projectKey: 'MOB',
        status: 'blocker',
      });
      expect(dashboard.recentActivity.map((item: { kind: string }) => item.kind)).toEqual(
        expect.arrayContaining(['result', 'run', 'defect']),
      );
    });

    it('ignores archived projects', async () => {
      const legacy = (
        await request('POST', '/api/v1/projects', asOwner({ name: 'Legacy', key: 'OLD' }))
      ).json();
      await createDefect('Old bug', 'critical', 'high', legacy.id);
      await request('POST', `/api/v1/projects/${legacy.id}/archive`, asOwner());

      const dashboard = await organizationDashboard();

      expect(dashboard.health).toMatchObject({ projects: 1, openDefects: 0 });
    });
  });

  describe('isolation and permissions', () => {
    it('never mixes another organization into any number', async () => {
      const [caseId] = (await createCases(1)) as [string];
      const run = await createRun('Private run', [caseId]);
      await record(run.id, run.runCaseIds[0] as string, 'failed');
      await createDefect('Private defect', 'critical');
      await createRequirement('Private requirement');
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const theirs = await request('GET', '/api/v1/dashboard/organization', {
        token: stranger.owner.accessToken,
        organizationId: stranger.organizationId,
      });
      const peek = await request(
        'GET',
        `/api/v1/projects/${workspace.projectId}/dashboard/summary`,
        { token: stranger.owner.accessToken, organizationId: stranger.organizationId },
      );
      const ownTrends = await request(
        'GET',
        `/api/v1/projects/${stranger.projectId}/dashboard/trends`,
        { token: stranger.owner.accessToken, organizationId: stranger.organizationId },
      );

      expect(theirs.statusCode).toBe(200);
      expect(theirs.json().health).toMatchObject({
        projects: 1,
        openDefects: 0,
        execution: { planned: 0 },
        coverage: { requirements: 0 },
      });
      expect(theirs.json().recentActivity).toEqual([]);
      expect(peek.statusCode).toBe(404);
      expect(
        ownTrends
          .json()
          .points.reduce((sum: number, point: { results: number }) => sum + point.results, 0),
      ).toBe(0);
    });

    it("keeps one project out of another project's numbers", async () => {
      const mobile = (
        await request('POST', '/api/v1/projects', asOwner({ name: 'Mobile app', key: 'MOB' }))
      ).json();
      await createDefect('Mobile only', 'critical', 'high', mobile.id);
      await createRequirement('Mobile requirement', 'medium', mobile.id);

      const web = await projectDashboard('summary');

      expect(web.defects.open).toBe(0);
      expect(web.coverage.requirements).toBe(0);
    });

    it('lets a viewer read analytics, and a revoke closes the project and drops it from totals', async () => {
      const viewer = await workspace.addMember('viewer');
      await createDefect('Visible defect', 'major');

      const allowed = await request(
        'GET',
        `/api/v1/projects/${workspace.projectId}/dashboard/defects`,
        as(viewer),
      );
      expect(allowed.statusCode).toBe(200);

      const revoke = await request(
        'PUT',
        `/api/v1/projects/${workspace.projectId}/permissions/members/${viewer.userId}`,
        asOwner({ overrides: [{ permission: 'analytics.read', effect: 'revoke' }] }),
      );
      expect(revoke.statusCode, revoke.body).toBe(200);

      const parts = ['summary', 'test-results', 'coverage', 'defects', 'trends'];
      for (const part of parts) {
        const refused = await request(
          'GET',
          `/api/v1/projects/${workspace.projectId}/dashboard/${part}`,
          as(viewer),
        );
        expect(refused.statusCode, part).toBe(403);
      }
      const organization = await request('GET', '/api/v1/dashboard/organization', as(viewer));
      expect(organization.statusCode).toBe(200);
      expect(organization.json().health).toMatchObject({ projects: 0, openDefects: 0 });
      expect(organization.json().projects).toEqual([]);
    });

    it('refuses anonymous callers', async () => {
      const response = await request(
        'GET',
        `/api/v1/projects/${workspace.projectId}/dashboard/summary`,
        { organizationId: workspace.organizationId },
      );

      expect(response.statusCode).toBe(401);
    });
  });
});
