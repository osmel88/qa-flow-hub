import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Quality gates (S6-F3), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner seeds QA data. The owner connection only asserts.
 */
describe('Quality gates', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;

  const request = injector(() => app);

  const errorOf = (response: { json: () => { error: { code: string; message: string } } }) => ({
    code: response.json().error.code,
    message: response.json().error.message,
  });

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
    app = await createTestApp({ databaseUrl: appRoleUrl() });
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

  interface RuleResult {
    type: string;
    result: string;
    actual: number | null;
    message: string;
    links: Array<{ kind: string; id: string }>;
  }
  interface Evaluation {
    gates: Array<{ gate: { id: string; name: string }; result: string; rules: RuleResult[] }>;
    required: { result: string; gateCount: number };
    override: { reason: string } | null;
    deployable: boolean;
  }

  let seq = 0;
  const release = async (version: string, workspace: TestWorkspace = acme) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/releases',
        as(
          workspace.owner,
          { projectId: workspace.projectId, name: `R ${version}`, version },
          workspace,
        ),
      ),
      201,
    );
  const env = async (name: string, body: object = {}) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/environments',
        as(acme.owner, { projectId: acme.projectId, name, ...body }),
      ),
      201,
    );
  const createGate = (body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request(
      'POST',
      '/api/v1/quality-gates',
      as(account, { projectId: workspace.projectId, name: `gate-${++seq}`, ...body }, workspace),
    );
  const gate = async (body: object) =>
    ok<{ id: string; version: number }>(await createGate(body), 201);
  const evaluate = async (
    releaseId: string,
    environmentId?: string,
    account: TestAccount = acme.owner,
  ) =>
    ok<Evaluation>(
      await request(
        'GET',
        `/api/v1/releases/${releaseId}/quality-gates${environmentId === undefined ? '' : `?environmentId=${environmentId}`}`,
        as(account),
      ),
    );
  const ruleOf = (view: Evaluation, type: string) =>
    view.gates.flatMap((entry) => entry.rules).find((rule) => rule.type === type)!;
  const report = (body: object, account: TestAccount = acme.owner) =>
    request('POST', '/api/v1/deployments', as(account, { projectId: acme.projectId, ...body }));
  const build = async (releaseId: string, status: string) =>
    ok<{ build: { id: string } }>(
      await request(
        'POST',
        '/api/v1/builds',
        as(acme.owner, { projectId: acme.projectId, identifier: `ci-${++seq}`, status, releaseId }),
      ),
    ).build;

  /** A run of the release with one case per status, seeded through the owner connection. */
  const seedRun = async (releaseId: string, statuses: string[], status = 'completed') => {
    const suite = await owner.testSuite.create({
      data: { organizationId: acme.organizationId, projectId: acme.projectId, name: `S${++seq}` },
    });
    const run = await owner.testRun.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        name: `Run ${seq}`,
        releaseId,
        status: status as 'completed',
      },
    });
    const cases = [];
    for (const latest of statuses) {
      const testCase = await owner.testCase.create({
        data: {
          organizationId: acme.organizationId,
          projectId: acme.projectId,
          suiteId: suite.id,
          key: `ACME-C-${++seq}`,
          title: `Case ${seq}`,
        },
      });
      cases.push(
        await owner.testRunCase.create({
          data: {
            organizationId: acme.organizationId,
            testRunId: run.id,
            testCaseId: testCase.id,
            caseSnapshot: {},
            caseVersion: 1,
            latestStatus: latest as 'passed',
          },
        }),
      );
    }
    return { run, cases };
  };
  const defect = (runId: string, severity: string) =>
    owner.defect.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: `ACME-D-${++seq}`,
        title: `Defect ${seq}`,
        severity: severity as 'major',
        testRunId: runId,
      },
    });

  it('evaluates every rule: pending without data, then pass and fail, and follows data changes', async () => {
    const r1 = await release('1.0.0');
    const all = await gate({
      rules: [
        { type: 'min_pass_rate', threshold: 80 },
        { type: 'max_failed_tests', threshold: 0 },
        { type: 'max_blocked_tests', threshold: 0 },
        { type: 'min_requirement_coverage', threshold: 50 },
        { type: 'max_open_critical_defects', threshold: 0 },
        { type: 'max_open_high_defects', threshold: 0 },
        { type: 'build_must_pass' },
        { type: 'completed_test_run_required' },
        { type: 'code_review_approval_required' },
      ],
    });
    const empty = await evaluate(r1.id);
    expect(empty.gates.map((entry) => entry.gate.id)).toEqual([all.id]);
    expect(
      Object.fromEntries(empty.gates[0]!.rules.map((rule) => [rule.type, rule.result])),
    ).toEqual({
      min_pass_rate: 'pending',
      max_failed_tests: 'pending',
      max_blocked_tests: 'pending',
      min_requirement_coverage: 'not_applicable',
      max_open_critical_defects: 'passed',
      max_open_high_defects: 'passed',
      build_must_pass: 'pending',
      completed_test_run_required: 'pending',
      code_review_approval_required: 'pending',
    });
    expect(empty.required.result).toBe('pending');

    const { run, cases } = await seedRun(
      r1.id,
      ['passed', 'passed', 'failed', 'blocked'],
      'in_progress',
    );
    const requirement = await owner.requirement.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: 'ACME-R-1',
        title: 'Pay',
      },
    });
    await owner.requirement.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: 'ACME-R-2',
        title: 'Ship',
      },
    });
    await owner.traceabilityLink.create({
      data: {
        organizationId: acme.organizationId,
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_case',
        targetId: cases[0]!.testCaseId,
        linkType: 'verifies',
      },
    });
    const critical = await defect(run.id, 'blocker');
    await defect(run.id, 'major');
    await defect(run.id, 'minor');
    const failedBuild = await build(r1.id, 'failed');
    const item = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(acme.owner, { projectId: acme.projectId, title: 'Story', releaseId: r1.id }),
      ),
      201,
    );
    const reviewer = await acme.addMember('tester', 'reviewer');
    const review = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/code-reviews',
        as(acme.owner, {
          projectId: acme.projectId,
          title: 'Review',
          reviewerIds: [reviewer.userId],
          workItemIds: [item.id],
        }),
      ),
      201,
    );

    const failing = await evaluate(r1.id);
    expect(failing.required.result).toBe('failed');
    expect(ruleOf(failing, 'min_pass_rate')).toEqual(
      expect.objectContaining({
        result: 'failed',
        actual: 50,
        links: [expect.objectContaining({ kind: 'test_run', id: run.id })],
      }),
    );
    expect(ruleOf(failing, 'max_failed_tests').result).toBe('failed');
    expect(ruleOf(failing, 'max_blocked_tests').result).toBe('failed');
    expect(ruleOf(failing, 'min_requirement_coverage')).toEqual(
      expect.objectContaining({ result: 'passed', actual: 50 }),
    );
    expect(ruleOf(failing, 'max_open_critical_defects').links.map((link) => link.id)).toEqual([
      critical.id,
    ]);
    expect(ruleOf(failing, 'max_open_high_defects').result).toBe('failed');
    expect(ruleOf(failing, 'build_must_pass')).toEqual(
      expect.objectContaining({
        result: 'failed',
        links: [expect.objectContaining({ kind: 'build', id: failedBuild.id })],
      }),
    );
    expect(ruleOf(failing, 'completed_test_run_required').result).toBe('pending');
    expect(ruleOf(failing, 'code_review_approval_required')).toEqual(
      expect.objectContaining({
        result: 'pending',
        links: [expect.objectContaining({ kind: 'code_review', id: review.id })],
      }),
    );

    await owner.testRunCase.updateMany({
      where: { testRunId: run.id },
      data: { latestStatus: 'passed' },
    });
    await owner.testRun.update({ where: { id: run.id }, data: { status: 'completed' } });
    await owner.defect.updateMany({ where: { testRunId: run.id }, data: { status: 'closed' } });
    await build(r1.id, 'passed');
    ok(
      await request(
        'POST',
        `/api/v1/code-reviews/${review.id}/decision`,
        as(reviewer, { decision: 'approve' }),
      ),
    );
    const passing = await evaluate(r1.id);
    expect(passing.gates[0]!.rules.filter((rule) => rule.result !== 'passed')).toEqual([]);
    expect([passing.required.result, passing.deployable]).toEqual(['passed', true]);
    await owner.requirement.updateMany({
      where: { key: 'ACME-R-2' },
      data: { status: 'obsolete' },
    });
    expect(ruleOf(await evaluate(r1.id), 'min_requirement_coverage').actual).toBe(100);
  });

  it('scopes gates to environments, combines required and optional gates and configures safely', async () => {
    const r1 = await release('2.0.0');
    const staging = await env('staging');
    const prod = await env('prod', { kind: 'production' });
    await gate({
      name: 'everywhere',
      rules: [{ type: 'max_open_critical_defects', threshold: 0 }],
    });
    const prodGate = await gate({
      name: 'prod only',
      environmentId: prod.id,
      rules: [{ type: 'build_must_pass' }],
    });
    await gate({
      name: 'advisory',
      required: false,
      environmentId: prod.id,
      rules: [{ type: 'completed_test_run_required' }],
    });
    expect((await evaluate(r1.id)).gates.map((entry) => entry.gate.name)).toEqual(['everywhere']);
    expect((await evaluate(r1.id, staging.id)).required).toEqual({
      result: 'passed',
      gateCount: 1,
    });
    const onProd = await evaluate(r1.id, prod.id);
    expect(onProd.gates.map((entry) => [entry.gate.name, entry.result])).toEqual([
      ['advisory', 'pending'],
      ['everywhere', 'passed'],
      ['prod only', 'pending'],
    ]);
    expect(onProd.required).toEqual({ result: 'pending', gateCount: 2 });
    await build(r1.id, 'passed');
    expect((await evaluate(r1.id, prod.id)).required.result).toBe('passed');

    expect(
      errorOf(await createGate({ name: 'EVERYWHERE', rules: [{ type: 'build_must_pass' }] })).code,
    ).toBe('DUPLICATE_RESOURCE');
    expect((await createGate({ rules: [] })).statusCode).toBe(400);
    expect(
      (await createGate({ rules: [{ type: 'min_pass_rate', threshold: 150 }] })).statusCode,
    ).toBe(400);
    const edits = await Promise.all(
      [1, 2].map((threshold) =>
        request(
          'PATCH',
          `/api/v1/quality-gates/${prodGate.id}`,
          as(acme.owner, {
            rules: [{ type: 'max_failed_tests', threshold }],
            version: prodGate.version,
          }),
        ),
      ),
    );
    expect(edits.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    ok(
      await request(
        'PATCH',
        `/api/v1/quality-gates/${prodGate.id}`,
        as(acme.owner, { enabled: false }),
      ),
    );
    expect((await evaluate(r1.id, prod.id)).required.gateCount).toBe(1);
    expect(
      (await request('DELETE', `/api/v1/quality-gates/${prodGate.id}`, as(acme.owner))).statusCode,
    ).toBe(204);
    expect(
      (await request('GET', `/api/v1/quality-gates/${prodGate.id}`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect(
      await owner.auditLog.count({ where: { entityType: 'QualityGate', entityId: prodGate.id } }),
    ).toBe(4);
  });

  it('blocks a protected environment until gates pass or an authorized override with a reason', async () => {
    const r1 = await release('3.0.0');
    const staging = await env('staging');
    const prod = await env('prod', { kind: 'production' });
    await gate({ environmentId: prod.id, rules: [{ type: 'build_must_pass' }] });
    await gate({ rules: [{ type: 'max_open_critical_defects', threshold: 0 }] });
    const failed = await build(r1.id, 'failed');
    const blocked = await report({ identifier: 'p-1', environmentId: prod.id, releaseId: r1.id });
    expect([blocked.statusCode, errorOf(blocked).code]).toEqual([409, 'QUALITY_GATE_FAILED']);
    expect(errorOf(blocked).message).toContain('Latest build');
    expect(errorOf(await report({ identifier: 'p-2', environmentId: prod.id })).code).toBe(
      'QUALITY_GATE_FAILED',
    );
    ok(await report({ identifier: 's-1', environmentId: staging.id, releaseId: r1.id }));
    expect(failed.id).toBeTruthy();
    const pipeline = ok<{
      stages: Array<{
        environment: { name: string };
        status: string;
        blockers: string[];
        gates: { result: string };
      }>;
    }>(await request('GET', `/api/v1/releases/${r1.id}/pipeline`, as(acme.owner)));
    const prodStage = pipeline.stages.find((stage) => stage.environment.name === 'prod')!;
    expect([prodStage.status, prodStage.blockers, prodStage.gates.result]).toEqual([
      'blocked',
      ['quality_gates'],
      'failed',
    ]);

    const tester = await acme.addMember('tester', 'tester');
    const overrideBy = (account: TestAccount, reason: string) =>
      request(
        'POST',
        `/api/v1/releases/${r1.id}/quality-gates/override`,
        as(account, { environmentId: prod.id, reason }),
      );
    expect((await overrideBy(tester, 'Hotfix approved by the CTO')).statusCode).toBe(403);
    expect((await overrideBy(acme.owner, 'short')).statusCode).toBe(400);
    const manager = await acme.addMember('project_manager', 'manager');
    const overridden = ok<Evaluation>(await overrideBy(manager, 'Hotfix approved by the CTO'), 201);
    expect([
      overridden.override?.reason,
      overridden.deployable,
      overridden.required.result,
    ]).toEqual(['Hotfix approved by the CTO', true, 'failed']);
    const audit = await owner.auditLog.findFirstOrThrow({
      where: { entityType: 'QualityGateOverride' },
    });
    expect(audit.summary).toContain('3.0.0');
    ok(
      await report({
        identifier: 'p-3',
        environmentId: prod.id,
        releaseId: r1.id,
        status: 'succeeded',
      }),
    );
    await expect(
      owner.$executeRawUnsafe(`SET ROLE qaflow_app; DELETE FROM quality_gate_overrides`),
    ).rejects.toThrow();

    const r2 = await release('3.1.0');
    await build(r2.id, 'passed');
    const pending = ok<{ deployment: { id: string } }>(
      await report({ identifier: 'q-1', environmentId: prod.id, releaseId: r2.id }),
    ).deployment;
    const run = await seedRun(r2.id, ['failed']);
    await defect(run.run.id, 'critical');
    const moving = await request(
      'POST',
      `/api/v1/deployments/${pending.id}/transition`,
      as(acme.owner, { status: 'deploying' }),
    );
    expect(errorOf(moving).code).toBe('QUALITY_GATE_FAILED');
    await owner.defect.updateMany({
      where: { testRunId: run.run.id },
      data: { status: 'resolved' },
    });
    ok(
      await request(
        'POST',
        `/api/v1/deployments/${pending.id}/transition`,
        as(acme.owner, { status: 'deploying' }),
      ),
    );
    expect((await overrideBy(manager, 'Nothing to override here')).statusCode).toBe(201);
  });

  it('keeps other projects, tenants and revoked permissions out, and reads one snapshot', async () => {
    const r1 = await release('4.0.0');
    const foreign = await release('9.0.0', globex);
    const theirs = ok<{ id: string }>(
      await createGate({ rules: [{ type: 'build_must_pass' }] }, globex.owner, globex),
      201,
    );
    expect(
      (await request('GET', `/api/v1/quality-gates/${theirs.id}`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/quality-gates/${theirs.id}`,
          as(acme.owner, { enabled: false }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await request('GET', `/api/v1/releases/${foreign.id}/quality-gates`, as(acme.owner)))
        .statusCode,
    ).toBe(404);
    expect(
      ok<unknown[]>(
        await request('GET', `/api/v1/quality-gates?projectId=${globex.projectId}`, as(acme.owner)),
      ),
    ).toEqual([]);
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' })),
      201,
    );
    const otherEnv = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/environments',
        as(acme.owner, { projectId: project.id, name: 'm-prod' }),
      ),
      201,
    );
    expect(
      (await createGate({ environmentId: otherEnv.id, rules: [{ type: 'build_must_pass' }] }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'GET',
          `/api/v1/releases/${r1.id}/quality-gates?environmentId=${otherEnv.id}`,
          as(acme.owner),
        )
      ).statusCode,
    ).toBe(404);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect(
      (await request('GET', `/api/v1/releases/${r1.id}/quality-gates`, as(hidden))).statusCode,
    ).toBe(404);
    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await evaluate(r1.id, undefined, viewer)).required.result).toBe('not_applicable');
    expect((await createGate({ rules: [{ type: 'build_must_pass' }] }, viewer)).statusCode).toBe(
      403,
    );
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${viewer.userId}`,
        as(acme.owner, { overrides: [{ permission: 'releases.read', effect: 'revoke' }] }),
      ),
    );
    expect(
      (await request('GET', `/api/v1/releases/${r1.id}/quality-gates`, as(viewer))).statusCode,
    ).toBe(403);

    await gate({ rules: [{ type: 'max_open_critical_defects', threshold: 0 }] });
    const { run } = await seedRun(r1.id, ['passed']);
    const defects = await Promise.all(Array.from({ length: 4 }, () => defect(run.id, 'blocker')));
    const writes = defects.map((row) =>
      owner.defect.update({ where: { id: row.id }, data: { status: 'closed' } }),
    );
    const reads = Array.from({ length: 6 }, () => evaluate(r1.id));
    const [views] = await Promise.all([Promise.all(reads), Promise.all(writes)]);
    for (const view of views) {
      const rule = ruleOf(view, 'max_open_critical_defects');
      expect(rule.actual).toBe(rule.links.length);
      expect(rule.result).toBe(rule.actual === 0 ? 'passed' : 'failed');
    }
    expect(ruleOf(await evaluate(r1.id), 'max_open_critical_defects').result).toBe('passed');
  });
});
