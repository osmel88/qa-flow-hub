import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Release readiness report (S7-F8), with the API connected as `qaflow_app` so
 * every source runs under Row Level Security: the four decisions, the blockers
 * and warnings behind them, tenant isolation and a project-level revoke.
 */
describe('Release readiness report', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;

  const request = injector(() => app);

  const ownerUrl = (): string =>
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';

  const appRoleUrl = (): string => {
    const url = new URL(ownerUrl());
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const truncate = async (): Promise<void> => {
    const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    const list = tables.map((row) => `"${row.tablename}"`).join(', ');
    await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" ENABLE TRIGGER USER`);
    }
  };

  const as = (account: TestAccount, payload?: object, workspace: TestWorkspace = acme) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: workspace.organizationId,
  });

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({
      databaseUrl: appRoleUrl(),
      ingestion: { rateLimitMax: 10_000, maxBytes: 64 * 1024, maxTests: 50 },
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(async () => {
    await truncate();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
    globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLX',
    });
  });

  const ok = <T>(
    response: { statusCode: number; body: string; json: () => unknown },
    status = 200,
  ): T => {
    expect(response.statusCode, response.body).toBe(status);
    return response.json() as T;
  };
  const post = (path: string, body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request('POST', path, as(account, body, workspace));
  const get = (path: string, account: TestAccount = acme.owner, workspace = acme) =>
    request('GET', path, as(account, undefined, workspace));

  let suiteId = '';
  beforeEach(() => {
    suiteId = '';
  });
  const testCase = async (title: string): Promise<string> => {
    if (suiteId === '') {
      suiteId = ok<{ id: string }>(
        await post('/api/v1/test-suites', { projectId: acme.projectId, name: 'Checkout' }),
        201,
      ).id;
    }
    return ok<{ id: string }>(await post('/api/v1/test-cases', { suiteId, title }), 201).id;
  };
  const STATUS: Record<string, string> = { P: 'passed', F: 'failed', B: 'blocked', S: 'skipped' };
  /** One run over `statuses` (one case each; `U` stays untested); returns result ids by case. */
  const run = async (
    cases: Record<string, string>,
    extra: { environment?: string; releaseId?: string } = {},
  ): Promise<{ runId: string; results: Record<string, string> }> => {
    const runId = ok<{ id: string }>(
      await post('/api/v1/test-runs', {
        projectId: acme.projectId,
        name: 'Regression',
        selection: { testCaseIds: Object.keys(cases) },
        ...extra,
      }),
      201,
    ).id;
    const rows = ok<{ data: Array<{ id: string; testCaseId: string }> }>(
      await get(`/api/v1/test-runs/${runId}/cases?pageSize=100`),
    ).data;
    const results: Record<string, string> = {};
    for (const row of rows) {
      const status = STATUS[cases[row.testCaseId] ?? 'U'];
      if (status !== undefined) {
        results[row.testCaseId] = ok<{ id: string }>(
          await post(`/api/v1/test-runs/${runId}/cases/${row.id}/results`, { status }),
          201,
        ).id;
      }
    }
    return { runId, results };
  };

  interface Reason {
    code: string;
    source: string;
    severity: string;
    count: number;
    message: string;
    items: Array<{ kind: string; id: string; label: string }>;
  }
  interface Readiness {
    release: { id: string; name: string };
    project: { id: string; key: string };
    decision: string;
    reasons: Reason[];
    blockers: Reason[];
    warnings: Reason[];
    metrics: {
      qualityGates: {
        gates: Array<{ name: string; required: boolean; result: string }>;
        failed: number;
      };
      execution: {
        runs: Array<{ id: string }>;
        kpis: { planned: number; executed: number; pending: number; verdicts: number };
        rates: { passRate: number | null; failedRate: number | null; insufficientData: boolean };
      };
      plans: Array<{ id: string; status: string; completion: number }>;
      cycles: Array<{ id: string; status: string }>;
      defects: { open: number; bySeverity: Record<string, number>; reopened: number };
      requirements: {
        total: number;
        covered: number;
        uncovered: number;
        coveredNotExecuted: number;
        failing: number;
        coverage: number | null;
      };
      flaky: Record<string, number>;
      exploratory: Record<string, number>;
    };
    thresholds: { minVerdicts: number; maxFailedRate: number };
    computedAt: string;
  }
  const readinessPath = (releaseId: string) => `/api/v1/releases/${releaseId}/readiness`;
  const readiness = async (releaseId: string, account = acme.owner) =>
    ok<Readiness>(await get(readinessPath(releaseId), account));
  const codes = (reasons: Reason[]) => reasons.map((r) => r.code);

  const release = async (workspace = acme) =>
    ok<{ id: string }>(
      await post(
        '/api/v1/releases',
        { projectId: workspace.projectId, name: 'Release 1', version: '1.0.0' },
        workspace.owner,
        workspace,
      ),
      201,
    ).id;
  const cases = async (count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) ids.push(await testCase(`Case ${i}`));
    return ids;
  };
  const statuses = (ids: string[], status: string) =>
    Object.fromEntries(ids.map((id) => [id, status]));
  const requirementFor = async (title: string, testCaseIds: string[]) => {
    const id = ok<{ id: string }>(
      await post('/api/v1/requirements', { projectId: acme.projectId, title }),
      201,
    ).id;
    for (const targetId of testCaseIds) {
      ok(
        await post('/api/v1/traceability/links', {
          sourceType: 'requirement',
          sourceId: id,
          targetType: 'test_case',
          targetId,
          linkType: 'verifies',
        }),
        201,
      );
    }
    return id;
  };

  it('is INSUFFICIENT DATA for a release without evidence, with no invented percentages', async () => {
    const releaseId = await release();
    const view = await readiness(releaseId);
    expect(view.release.id).toBe(releaseId);
    expect(view.project).toMatchObject({ id: acme.projectId });
    expect(view.decision).toBe('insufficient_data');
    expect(codes(view.reasons)).toEqual(['not_enough_verdicts']);
    expect(view.blockers).toEqual([]);
    expect(view.metrics.execution.kpis).toMatchObject({ planned: 0, executed: 0, verdicts: 0 });
    expect(view.metrics.execution.rates).toMatchObject({ passRate: null, failedRate: null });
    expect(view.metrics.requirements.coverage).toBeNull();
    expect(view.metrics.plans).toEqual([]);
    expect(view.metrics.cycles).toEqual([]);
    expect(view.thresholds).toEqual({ minVerdicts: 5, maxFailedRate: 10 });
    expect(Number.isNaN(Date.parse(view.computedAt))).toBe(false);
  });

  it('is INSUFFICIENT DATA below the minimum sample', async () => {
    const releaseId = await release();
    const ids = await cases(3);
    await run(statuses(ids, 'P'), { releaseId });
    const view = await readiness(releaseId);
    expect(view.decision).toBe('insufficient_data');
    expect(view.reasons[0]).toMatchObject({ code: 'not_enough_verdicts', count: 3 });
    expect(view.metrics.execution.rates.passRate).toBeNull();
    expect(view.metrics.execution.rates.insufficientData).toBe(true);
  });

  it('is GO with every case passed, full coverage and a passing required gate', async () => {
    const releaseId = await release();
    const ids = await cases(5);
    await requirementFor('Card payments', ids);
    ok(
      await post('/api/v1/quality-gates', {
        projectId: acme.projectId,
        name: 'No failures',
        rules: [{ type: 'max_failed_tests', threshold: 0 }],
      }),
      201,
    );
    await run(statuses(ids, 'P'), { releaseId });
    const view = await readiness(releaseId);
    expect(view.decision).toBe('go');
    expect(codes(view.reasons)).toEqual(['all_checks_passed']);
    expect(view.warnings).toEqual([]);
    expect(view.metrics.qualityGates.gates).toEqual([
      expect.objectContaining({ name: 'No failures', required: true, result: 'passed' }),
    ]);
    expect(view.metrics.execution.rates).toMatchObject({ passRate: 100, failedRate: 0 });
    expect(view.metrics.requirements).toMatchObject({
      total: 1,
      covered: 1,
      uncovered: 0,
      coverage: 100,
    });
  });

  it('is NO-GO with an open critical defect, and the failure rate above the threshold', async () => {
    const releaseId = await release();
    const ids = await cases(6);
    const [failing] = ids as [string];
    const { results } = await run({ ...statuses(ids, 'P'), [failing]: 'F' }, { releaseId });
    for (const title of ['Refund fails', 'Refund fails twice']) {
      ok(
        await post('/api/v1/defects', {
          projectId: acme.projectId,
          title,
          severity: 'critical',
          testResultId: results[failing],
        }),
        201,
      );
    }
    const view = await readiness(releaseId);
    expect(view.decision).toBe('no_go');
    expect(view.blockers.find((b) => b.code === 'critical_defects_open')).toMatchObject({
      source: 'defects',
      count: 2,
      message: '2 blocker/critical defects remain open.',
    });
    expect(codes(view.blockers)).toContain('failed_rate_above_threshold');
    expect(view.reasons).toEqual(view.blockers);
    expect(view.metrics.defects).toMatchObject({ open: 2, reopened: 0 });
    expect(view.metrics.defects.bySeverity).toMatchObject({ critical: 2, major: 0 });
  });

  it('is NO-GO when a required gate fails; an optional failing gate is only a warning', async () => {
    const releaseId = await release();
    const ids = await cases(10);
    await run({ ...statuses(ids, 'P'), [ids[0]!]: 'B' }, { releaseId });
    ok(
      await post('/api/v1/quality-gates', {
        projectId: acme.projectId,
        name: 'Advisory',
        required: false,
        rules: [{ type: 'max_blocked_tests', threshold: 0 }],
      }),
      201,
    );
    const advisory = await readiness(releaseId);
    expect(advisory.decision).toBe('go_with_risks');
    expect(codes(advisory.warnings)).toEqual(
      expect.arrayContaining(['optional_gate_failed', 'tests_blocked']),
    );
    ok(
      await post('/api/v1/quality-gates', {
        projectId: acme.projectId,
        name: 'Blocking',
        rules: [{ type: 'max_blocked_tests', threshold: 0 }],
      }),
      201,
    );
    const view = await readiness(releaseId);
    expect(view.decision).toBe('no_go');
    expect(view.blockers[0]).toMatchObject({
      code: 'required_gate_failed',
      source: 'quality_gates',
      items: [expect.objectContaining({ kind: 'quality_gate', label: 'Blocking' })],
    });
    expect(view.metrics.qualityGates.failed).toBe(2);
  });

  it('is NO-GO while a cycle of the release is not completed', async () => {
    const releaseId = await release();
    const ids = await cases(5);
    const planId = ok<{ id: string }>(
      await post('/api/v1/test-plans', {
        projectId: acme.projectId,
        name: 'Release plan',
        releaseId,
        suiteIds: [suiteId],
      }),
      201,
    ).id;
    ok(await post(`/api/v1/test-plans/${planId}/start`, {}));
    const cycleId = ok<{ id: string }>(
      await post('/api/v1/test-cycles', { testPlanId: planId, name: 'Cycle one', releaseId }),
      201,
    ).id;
    ok(await post(`/api/v1/test-cycles/${cycleId}/start`, {}));
    await run(statuses(ids, 'P'), { releaseId });
    const view = await readiness(releaseId);
    expect(view.decision).toBe('no_go');
    expect(view.blockers[0]).toMatchObject({
      code: 'cycle_incomplete',
      source: 'test_cycles',
      items: [{ kind: 'test_cycle', id: cycleId, label: 'Cycle one' }],
    });
    expect(view.metrics.cycles).toEqual([
      expect.objectContaining({ id: cycleId, status: 'active' }),
    ]);
    expect(view.metrics.plans).toEqual([expect.objectContaining({ id: planId })]);
    expect(codes(view.warnings)).toContain('plan_incomplete');
  });

  it('is GO WITH RISKS with missing coverage, a flaky case, a major defect and open exploratory work', async () => {
    const releaseId = await release();
    const ids = await cases(7);
    const [flakyCase, notRun, blocked] = ids as [string, string, string];
    for (const status of ['F', 'P', 'F', 'P', 'F']) {
      await run({ [flakyCase]: status });
    }
    const executed = ids.filter((id) => id !== notRun);
    const { results } = await run(
      { ...statuses(executed, 'P'), [notRun]: 'U', [blocked]: 'B' },
      { releaseId },
    );
    await requirementFor('Covered', [flakyCase]);
    await requirementFor('Not executed', [notRun]);
    ok(await post('/api/v1/requirements', { projectId: acme.projectId, title: 'Uncovered' }), 201);
    ok(
      await post('/api/v1/defects', {
        projectId: acme.projectId,
        title: 'Slow checkout',
        severity: 'major',
        testResultId: results[blocked],
      }),
      201,
    );
    const session = ok<{ id: string }>(
      await post('/api/v1/exploratory-sessions', {
        projectId: acme.projectId,
        title: 'Payments tour',
        charter: 'Explore refunds',
        releaseId,
      }),
      201,
    );
    ok(await post(`/api/v1/exploratory-sessions/${session.id}/start`, {}));
    ok(
      await post(`/api/v1/exploratory-sessions/${session.id}/findings`, {
        title: 'Rounding',
        severity: 'major',
      }),
      201,
    );

    const view = await readiness(releaseId);
    expect(view.decision).toBe('go_with_risks');
    expect(view.blockers).toEqual([]);
    expect(codes(view.warnings)).toEqual([
      'high_defects_open',
      'tests_blocked',
      'executions_pending',
      'requirements_uncovered',
      'requirements_not_executed',
      'flaky_tests',
      'exploratory_incomplete',
      'findings_open',
    ]);
    expect(view.warnings.find((w) => w.code === 'flaky_tests')?.items).toEqual([
      expect.objectContaining({ kind: 'test_case', id: flakyCase }),
    ]);
    expect(view.metrics.flaky).toMatchObject({ flaky: 1, confirmed: 0, dismissed: 0 });
    expect(view.metrics.requirements).toMatchObject({
      total: 3,
      covered: 2,
      uncovered: 1,
      coveredNotExecuted: 1,
      coverage: 66.7,
    });
    expect(view.metrics.exploratory).toMatchObject({
      sessions: 1,
      incomplete: 1,
      findings: 1,
      openFindings: 1,
      convertedFindings: 0,
    });
  });

  it('answers 404 for a release of another tenant', async () => {
    const foreign = await release(globex);
    expect((await get(readinessPath(foreign))).statusCode).toBe(404);
    const own = await release();
    expect((await get(readinessPath(own), globex.owner, globex)).statusCode).toBe(404);
    expect((await get(readinessPath('missing-release-id'))).statusCode).toBe(404);
  });

  it('lets a viewer read it and refuses it after a project-level revoke of analytics.read', async () => {
    const releaseId = await release();
    const viewer = await acme.addMember('viewer');
    expect((await get(readinessPath(releaseId), viewer)).statusCode).toBe(200);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${viewer.userId}`,
        as(acme.owner, { overrides: [{ permission: 'analytics.read', effect: 'revoke' }] }),
      ),
    );
    expect((await get(readinessPath(releaseId), viewer)).statusCode).toBe(403);
  });
});
