import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Release approvals (S6-F4), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Release approvals', () => {
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

  interface Requirement {
    type: string;
    requiredApprovals: number;
    approvals: number;
    state: string;
  }
  interface Approvals {
    state: string;
    requirements: Requirement[];
    history: Array<{
      id: string;
      type: string;
      decision: string;
      approver: { id: string } | null;
      revokedAt: string | null;
      revokedBy: { id: string } | null;
    }>;
    actions: { decide: boolean; selfApprovalBlocked: string[] };
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
  const createRule = (body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request(
      'POST',
      '/api/v1/release-approval-rules',
      as(account, { projectId: workspace.projectId, ...body }, workspace),
    );
  const rule = async (body: object) =>
    ok<{ id: string; version: number }>(await createRule(body), 201);
  const decide = (releaseId: string, account: TestAccount, body: object) =>
    request('POST', `/api/v1/releases/${releaseId}/approvals`, as(account, body));
  const approve = async (
    releaseId: string,
    account: TestAccount,
    type: string,
    environmentId?: string,
  ) =>
    ok<Approvals>(
      await decide(releaseId, account, {
        type,
        action: 'approve',
        ...(environmentId === undefined ? {} : { environmentId }),
      }),
      201,
    );
  const view = async (
    releaseId: string,
    environmentId?: string,
    account: TestAccount = acme.owner,
  ) =>
    ok<Approvals>(
      await request(
        'GET',
        `/api/v1/releases/${releaseId}/approvals${environmentId === undefined ? '' : `?environmentId=${environmentId}`}`,
        as(account),
      ),
    );
  const revoke = (releaseId: string, approvalId: string, account: TestAccount) =>
    request(
      'POST',
      `/api/v1/releases/${releaseId}/approvals/${approvalId}/revoke`,
      as(account, { reason: 'Found a regression' }),
    );
  const stateOf = (approvals: Approvals, type: string) =>
    approvals.requirements.find((entry) => entry.type === type)!;
  const report = (body: object) =>
    request(
      'POST',
      '/api/v1/deployments',
      as(acme.owner, { projectId: acme.projectId, identifier: `d-${++seq}`, ...body }),
    );
  const build = async (releaseId: string, status: string) =>
    ok(
      await request(
        'POST',
        '/api/v1/builds',
        as(acme.owner, { projectId: acme.projectId, identifier: `ci-${++seq}`, status, releaseId }),
      ),
    );

  it('derives the workflow from rules and live decisions, with multiple and concurrent approvers', async () => {
    const r1 = await release('1.0.0');
    await rule({ type: 'qa', requiredApprovals: 2 });
    await rule({ type: 'product' });
    const initial = await view(r1.id);
    expect([
      initial.state,
      initial.requirements.map((entry) => [
        entry.type,
        entry.approvals,
        entry.requiredApprovals,
        entry.state,
      ]),
    ]).toEqual([
      'pending',
      [
        ['qa', 0, 2, 'pending'],
        ['product', 0, 1, 'pending'],
      ],
    ]);
    expect(initial.actions.selfApprovalBlocked).toEqual(['qa', 'product']);
    const self = await decide(r1.id, acme.owner, { type: 'qa', action: 'approve' });
    expect([self.statusCode, errorOf(self).code]).toEqual([403, 'FORBIDDEN']);

    const [t1, t2, t3, lead, manager] = await Promise.all([
      acme.addMember('tester', 't1'),
      acme.addMember('tester', 't2'),
      acme.addMember('tester', 't3'),
      acme.addMember('qa_lead', 'lead'),
      acme.addMember('project_manager', 'manager'),
    ]);
    await approve(r1.id, t1, 'qa');
    expect(errorOf(await decide(r1.id, t1, { type: 'qa', action: 'approve' })).code).toBe(
      'DUPLICATE_RESOURCE',
    );
    expect((await decide(r1.id, t1, { type: 'product', action: 'reject' })).statusCode).toBe(400);
    expect(
      (await decide(r1.id, t1, { type: 'product', action: 'request_changes', comment: 'no' }))
        .statusCode,
    ).toBe(400);

    const both = await Promise.all(
      [t2, t3].map((account) => decide(r1.id, account, { type: 'qa', action: 'approve' })),
    );
    expect(both.map((result) => result.statusCode)).toEqual([201, 201]);
    expect(stateOf(await view(r1.id), 'qa')).toEqual(
      expect.objectContaining({ approvals: 3, state: 'approved' }),
    );

    const race = await Promise.all([
      decide(r1.id, manager, { type: 'product', action: 'approve' }),
      decide(r1.id, lead, { type: 'product', action: 'reject', comment: 'Pricing copy is wrong' }),
    ]);
    expect(race.map((result) => result.statusCode)).toEqual([201, 201]);
    const rejected = await view(r1.id);
    expect([rejected.state, stateOf(rejected, 'product').state]).toEqual(['rejected', 'rejected']);
    const sameApprover = await Promise.all([
      decide(r1.id, t1, { type: 'product', action: 'approve' }),
      decide(r1.id, t1, {
        type: 'product',
        action: 'request_changes',
        comment: 'Needs another look',
      }),
    ]);
    expect(sameApprover.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    const t1Product = (await view(r1.id)).history.find(
      (entry) =>
        entry.type === 'product' && entry.approver?.id === t1.userId && entry.revokedAt === null,
    )!;
    expect((await revoke(r1.id, t1Product.id, t2)).statusCode).toBe(403);
    ok(await revoke(r1.id, t1Product.id, manager));
    const leadReject = (await view(r1.id)).history.find((entry) => entry.decision === 'rejected')!;
    const afterRevoke = ok<Approvals>(await revoke(r1.id, leadReject.id, lead));
    expect(afterRevoke.state).toBe('approved');
    expect(errorOf(await revoke(r1.id, leadReject.id, lead)).code).toBe('CONFLICT');
    expect(afterRevoke.history.find((entry) => entry.id === leadReject.id)?.revokedBy?.id).toBe(
      lead.userId,
    );
    expect(afterRevoke.history).toHaveLength(6);

    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await view(r1.id, undefined, viewer)).actions.decide).toBe(false);
    expect((await decide(r1.id, viewer, { type: 'qa', action: 'approve' })).statusCode).toBe(403);
    expect(await owner.auditLog.count({ where: { entityType: 'ReleaseApproval' } })).toBe(8);
    await expect(
      owner.$executeRawUnsafe(`SET ROLE qaflow_app; DELETE FROM release_approvals`),
    ).rejects.toThrow();
  });

  it('blocks protected environments until approvals are complete, on top of quality gates', async () => {
    const staging = await env('staging');
    const prod = await env('prod', { kind: 'production' });
    await rule({ type: 'release_manager', environmentId: prod.id });
    ok(
      await request(
        'POST',
        '/api/v1/quality-gates',
        as(acme.owner, {
          projectId: acme.projectId,
          name: 'build',
          environmentId: prod.id,
          rules: [{ type: 'build_must_pass' }],
        }),
      ),
      201,
    );
    const manager = await acme.addMember('project_manager', 'manager');

    const r1 = await release('2.0.0');
    await build(r1.id, 'passed');
    expect((await view(r1.id)).requirements).toEqual([]);
    expect((await view(r1.id, prod.id)).state).toBe('pending');
    const missing = await report({ environmentId: prod.id, releaseId: r1.id });
    expect([missing.statusCode, errorOf(missing).code]).toEqual([409, 'APPROVAL_REQUIRED']);
    expect(errorOf(missing).message).toContain('Release Manager pending (0/1)');
    expect(errorOf(await report({ environmentId: prod.id })).code).toBe('QUALITY_GATE_FAILED');
    ok(await report({ environmentId: staging.id, releaseId: r1.id }));
    const pipeline = ok<{
      stages: Array<{
        environment: { name: string };
        status: string;
        blockers: string[];
        approvals: { state: string };
      }>;
    }>(await request('GET', `/api/v1/releases/${r1.id}/pipeline`, as(acme.owner)));
    const prodStage = pipeline.stages.find((stage) => stage.environment.name === 'prod')!;
    expect([prodStage.status, prodStage.blockers, prodStage.approvals.state]).toEqual([
      'blocked',
      ['approvals'],
      'pending',
    ]);
    await approve(r1.id, manager, 'release_manager', staging.id);
    expect((await view(r1.id, prod.id)).state).toBe('pending');
    await approve(r1.id, manager, 'release_manager', prod.id);
    ok(await report({ environmentId: prod.id, releaseId: r1.id, status: 'succeeded' }));

    const r2 = await release('2.1.0');
    await build(r2.id, 'failed');
    await approve(r2.id, manager, 'release_manager');
    expect((await view(r2.id, prod.id)).state).toBe('approved');
    expect(errorOf(await report({ environmentId: prod.id, releaseId: r2.id })).code).toBe(
      'QUALITY_GATE_FAILED',
    );

    const r3 = await release('2.2.0');
    await build(r3.id, 'passed');
    const approved = await approve(r3.id, manager, 'release_manager', prod.id);
    const pending = ok<{ deployment: { id: string } }>(
      await report({ environmentId: prod.id, releaseId: r3.id }),
    ).deployment;
    ok(await revoke(r3.id, approved.history[0]!.id, manager));
    const moving = await request(
      'POST',
      `/api/v1/deployments/${pending.id}/transition`,
      as(acme.owner, { status: 'deploying' }),
    );
    expect(errorOf(moving).code).toBe('APPROVAL_REQUIRED');
    await approve(r3.id, manager, 'release_manager', prod.id);
    ok(
      await request(
        'POST',
        `/api/v1/deployments/${pending.id}/transition`,
        as(acme.owner, { status: 'deploying' }),
      ),
    );
  });

  it('refuses decisions on archived releases and keeps their history', async () => {
    await rule({ type: 'qa' });
    const r1 = await release('3.0.0');
    const tester = await acme.addMember('tester', 'tester');
    const approved = await approve(r1.id, tester, 'qa');
    ok(await request('POST', `/api/v1/releases/${r1.id}/archive`, as(acme.owner)));
    expect(
      errorOf(
        await decide(r1.id, tester, { type: 'qa', action: 'reject', comment: 'Too late now' }),
      ).code,
    ).toBe('CONFLICT');
    expect(errorOf(await revoke(r1.id, approved.history[0]!.id, tester)).code).toBe('CONFLICT');
    const archived = await view(r1.id, undefined, tester);
    expect([archived.state, archived.history.length, archived.actions.decide]).toEqual([
      'approved',
      1,
      false,
    ]);
  });

  it('keeps other projects, tenants, hidden members and revoked permissions out', async () => {
    const r1 = await release('4.0.0');
    const foreign = await release('9.0.0', globex);
    const tester = await acme.addMember('tester', 'tester');
    expect(
      (await request('GET', `/api/v1/releases/${foreign.id}/approvals`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect((await decide(foreign.id, tester, { type: 'qa', action: 'approve' })).statusCode).toBe(
      404,
    );
    const theirs = ok<{ id: string }>(await createRule({ type: 'qa' }, globex.owner, globex), 201);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/release-approval-rules/${theirs.id}`,
          as(acme.owner, { enabled: false }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      ok<unknown[]>(
        await request(
          'GET',
          `/api/v1/release-approval-rules?projectId=${globex.projectId}`,
          as(acme.owner),
        ),
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
    expect((await createRule({ type: 'qa', environmentId: otherEnv.id })).statusCode).toBe(404);
    expect(
      (await decide(r1.id, tester, { type: 'qa', action: 'approve', environmentId: otherEnv.id }))
        .statusCode,
    ).toBe(404);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect(
      (await request('GET', `/api/v1/releases/${r1.id}/approvals`, as(hidden))).statusCode,
    ).toBe(404);

    const first = await rule({ type: 'qa' });
    expect(errorOf(await createRule({ type: 'qa' })).code).toBe('DUPLICATE_RESOURCE');
    const edits = await Promise.all(
      [2, 3].map((requiredApprovals) =>
        request(
          'PATCH',
          `/api/v1/release-approval-rules/${first.id}`,
          as(acme.owner, { requiredApprovals, version: first.version }),
        ),
      ),
    );
    expect(edits.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect((await createRule({ type: 'qa' }, tester)).statusCode).toBe(403);

    expect((await view(r1.id, undefined, tester)).actions.decide).toBe(true);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${tester.userId}`,
        as(acme.owner, { overrides: [{ permission: 'releases.approve', effect: 'revoke' }] }),
      ),
    );
    expect((await decide(r1.id, tester, { type: 'qa', action: 'approve' })).statusCode).toBe(403);
    expect((await view(r1.id, undefined, tester)).actions.decide).toBe(false);
    expect(await owner.releaseApproval.count()).toBe(0);
  });
});
