import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Code reviews (S5-F3), with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Code reviews', () => {
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

  interface Review {
    id: string;
    status: string;
    version: number;
    reviewers: Array<{ user: { id: string }; decision: string; canReview: boolean }>;
    mergeReadiness: {
      ready: boolean;
      approvals: number;
      requiredApprovals: number;
      blockers: string[];
    };
    events: Array<{ kind: string }>;
    workItems: Array<{ id: string }>;
  }

  const item = async (title: string, workspace: TestWorkspace = acme, projectId?: string) =>
    ok<{ id: string; key: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(workspace.owner, { projectId: projectId ?? workspace.projectId, title }, workspace),
      ),
      201,
    );
  const pullRequest = async (
    prNumber: number,
    projectId = acme.projectId,
    workItemIds: string[] = [],
  ) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/development-artifacts',
        as(acme.owner, { projectId, kind: 'pull_request', prNumber, status: 'open', workItemIds }),
      ),
      201,
    );
  const open = (body: object, account: TestAccount = acme.owner, workspace: TestWorkspace = acme) =>
    request(
      'POST',
      '/api/v1/code-reviews',
      as(
        account,
        { projectId: workspace.projectId, title: 'Review card payments', ...body },
        workspace,
      ),
    );
  const review = async (body: object) => ok<Review>(await open(body), 201);
  const decide = (id: string, account: TestAccount, decision: string, comment?: string) =>
    request(
      'POST',
      `/api/v1/code-reviews/${id}/decision`,
      as(account, { decision, ...(comment === undefined ? {} : { comment }) }),
    );
  const get = async (id: string, account: TestAccount = acme.owner) =>
    ok<Review>(await request('GET', `/api/v1/code-reviews/${id}`, as(account)));
  const storedConsistent = async (id: string) => {
    const row = await owner.codeReview.findUniqueOrThrow({
      where: { id },
      include: { reviewers: true },
    });
    const decisions = row.reviewers.map((reviewer) => reviewer.decision);
    const approvals = decisions.filter((decision) => decision === 'approved').length;
    const expected = decisions.includes('changes_requested')
      ? 'changes_requested'
      : approvals >= (row.requiredApprovals ?? 1)
        ? 'approved'
        : decisions.some((decision) => decision !== 'pending')
          ? 'in_review'
          : 'pending';
    expect(row.status).toBe(expected);
    return row;
  };

  it('needs distinct approvals from assigned reviewers and derives merge readiness', async () => {
    const first = await acme.addMember('tester', 'rev-one');
    const second = await acme.addMember('tester', 'rev-two');
    const pr = await pullRequest(7);
    // The author can never be a reviewer.
    expect(errorOf(await open({ reviewerIds: [acme.owner.userId] })).code).toBe('VALIDATION_ERROR');
    const created = await review({
      pullRequestId: pr.id,
      reviewerIds: [first.userId, second.userId],
      requiredApprovals: 2,
    });
    expect(created.status).toBe('pending');
    expect(created.mergeReadiness).toEqual({
      ready: false,
      approvals: 0,
      requiredApprovals: 2,
      blockers: ['insufficient_approvals'],
    });
    const selfApproval = await decide(created.id, acme.owner, 'approve');
    expect([selfApproval.statusCode, errorOf(selfApproval).code]).toEqual([403, 'FORBIDDEN']);
    const outsider = await acme.addMember('tester', 'outsider');
    expect((await decide(created.id, outsider, 'approve')).statusCode).toBe(403);

    expect(ok<Review>(await decide(created.id, first, 'approve', 'LGTM')).status).toBe('in_review');
    const duplicate = await decide(created.id, first, 'approve');
    expect([duplicate.statusCode, errorOf(duplicate).code]).toEqual([409, 'CONFLICT']);
    const approved = ok<Review>(await decide(created.id, second, 'approve'));
    expect([approved.status, approved.mergeReadiness.ready]).toEqual(['approved', true]);

    // A change request wins; revoking it gives the approvals back.
    expect(
      ok<Review>(await decide(created.id, second, 'request_changes', 'Missing test')).status,
    ).toBe('changes_requested');
    expect((await get(created.id)).mergeReadiness.blockers).toEqual([
      'changes_requested',
      'insufficient_approvals',
    ]);
    expect(ok<Review>(await decide(created.id, second, 'revoke')).status).toBe('in_review');
    expect((await decide(created.id, second, 'revoke')).statusCode).toBe(409);
    ok(await decide(created.id, second, 'approve'));

    // The project rule applies when the review sets none.
    ok(
      await request(
        'PATCH',
        `/api/v1/code-reviews/${created.id}`,
        as(acme.owner, { requiredApprovals: null }),
      ),
    );
    ok(
      await request(
        'PUT',
        '/api/v1/code-reviews/settings',
        as(acme.owner, { projectId: acme.projectId, requiredApprovals: 3 }),
      ),
    );
    expect((await get(created.id)).mergeReadiness).toMatchObject({
      ready: false,
      requiredApprovals: 3,
    });
    ok(
      await request(
        'PUT',
        '/api/v1/code-reviews/settings',
        as(acme.owner, { projectId: acme.projectId, requiredApprovals: 1 }),
      ),
    );
    expect((await get(created.id)).mergeReadiness.ready).toBe(true);

    // Merging the PR closes the window; dismissing an approval needs manage.
    ok(
      await request(
        'PATCH',
        `/api/v1/development-artifacts/${pr.id}`,
        as(acme.owner, { status: 'merged' }),
      ),
    );
    expect((await get(created.id)).mergeReadiness.blockers).toEqual(['pull_request_not_open']);
    expect(
      (
        await request(
          'POST',
          `/api/v1/code-reviews/${created.id}/reviewers/${first.userId}/dismiss`,
          as(second, {}),
        )
      ).statusCode,
    ).toBe(403);
    const dismissedOne = ok<Review>(
      await request(
        'POST',
        `/api/v1/code-reviews/${created.id}/reviewers/${first.userId}/dismiss`,
        as(acme.owner, { comment: 'Stale after rebase' }),
      ),
    );
    expect(dismissedOne.reviewers.find((entry) => entry.user.id === first.userId)?.decision).toBe(
      'dismissed',
    );
    const dismissed = ok<Review>(
      await request('POST', `/api/v1/code-reviews/${created.id}/dismiss`, as(acme.owner, {})),
    );
    expect([dismissed.status, dismissed.mergeReadiness.ready]).toEqual(['dismissed', false]);
    expect((await decide(created.id, first, 'approve')).statusCode).toBe(409);
    expect(dismissed.events.map((event) => event.kind)).toEqual([
      'created',
      'approved',
      'approved',
      'changes_requested',
      'decision_revoked',
      'approved',
      'updated',
      'approval_dismissed',
      'dismissed',
    ]);
    const audits = await owner.auditLog.count({
      where: { entityId: created.id, entityType: 'CodeReview' },
    });
    expect(audits).toBe(9);
  });

  it('applies concurrent decisions one at a time', async () => {
    const first = await acme.addMember('tester', 'rev-one');
    const second = await acme.addMember('tester', 'rev-two');
    const both = await review({ reviewerIds: [first.userId, second.userId], requiredApprovals: 2 });
    const together = await Promise.all([
      decide(both.id, first, 'approve'),
      decide(both.id, second, 'approve'),
    ]);
    expect(together.map((response) => response.statusCode)).toEqual([200, 200]);
    expect((await storedConsistent(both.id)).status).toBe('approved');

    const twice = await review({ reviewerIds: [first.userId] });
    const duplicates = await Promise.all([
      decide(twice.id, first, 'approve'),
      decide(twice.id, first, 'approve'),
      decide(twice.id, first, 'approve'),
    ]);
    expect(duplicates.map((response) => response.statusCode).sort()).toEqual([200, 409, 409]);
    expect(
      await owner.codeReviewEvent.count({ where: { reviewId: twice.id, kind: 'approved' } }),
    ).toBe(1);

    for (let round = 0; round < 3; round += 1) {
      const raced = await review({ reviewerIds: [first.userId, second.userId] });
      const results = await Promise.all([
        decide(raced.id, first, 'approve'),
        decide(raced.id, second, 'request_changes'),
        request('POST', `/api/v1/code-reviews/${raced.id}/dismiss`, as(acme.owner, {})),
      ]);
      expect(results.every((response) => [200, 409].includes(response.statusCode))).toBe(true);
      const row = await owner.codeReview.findUniqueOrThrow({ where: { id: raced.id } });
      if (row.status !== 'dismissed') {
        await storedConsistent(raced.id);
      }
    }
  });

  it('refuses reviewers without access and anything from another project or tenant', async () => {
    const viewer = await acme.addMember('viewer', 'viewer');
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    for (const userId of [viewer.userId, hidden.userId, globex.owner.userId]) {
      expect(errorOf(await open({ reviewerIds: [userId] })).code).toBe('VALIDATION_ERROR');
    }
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile app', key: 'MOB' })),
      201,
    );
    const otherPr = await pullRequest(3, project.id);
    const otherItem = await item('Mobile item', acme, project.id);
    const foreignItem = await item('Globex item', globex);
    expect((await open({ pullRequestId: otherPr.id })).statusCode).toBe(404);
    expect((await open({ workItemIds: [otherItem.id] })).statusCode).toBe(404);
    expect((await open({ workItemIds: [foreignItem.id] })).statusCode).toBe(404);

    const created = await review({});
    expect(
      (
        await request(
          'POST',
          `/api/v1/code-reviews/${created.id}/work-items`,
          as(acme.owner, { workItemId: otherItem.id }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'GET',
          `/api/v1/code-reviews/${created.id}`,
          as(globex.owner, undefined, globex),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await request('GET', `/api/v1/code-reviews/${created.id}`, as(hidden))).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/api/v1/code-reviews/${created.id}/reviewers`,
          as(acme.owner, { userId: viewer.userId }),
        )
      ).statusCode,
    ).toBe(400);
    const theirs = ok<{ data: unknown[] }>(
      await request(
        'GET',
        `/api/v1/code-reviews?projectId=${acme.projectId}`,
        as(globex.owner, undefined, globex),
      ),
    );
    expect(theirs.data).toEqual([]);
    expect(await owner.codeReview.count({ where: { organizationId: globex.organizationId } })).toBe(
      0,
    );
  });

  it('stops counting a reviewer whose permission is revoked while the review is open', async () => {
    const first = await acme.addMember('tester', 'rev-one');
    const created = await review({ reviewerIds: [first.userId] });
    ok(await decide(created.id, first, 'approve'));
    expect((await get(created.id)).mergeReadiness.ready).toBe(true);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${first.userId}`,
        as(acme.owner, { overrides: [{ permission: 'code_reviews.review', effect: 'revoke' }] }),
      ),
    );
    const after = await get(created.id);
    expect(after.reviewers[0]?.canReview).toBe(false);
    expect(after.mergeReadiness).toMatchObject({ ready: false, approvals: 0 });
    expect((await decide(created.id, first, 'revoke')).statusCode).toBe(403);
    // Reading stays possible with work_items.read.
    expect((await get(created.id, first)).id).toBe(created.id);
  });

  it('feeds the development status of linked work items and keeps history after deletion', async () => {
    const first = await acme.addMember('tester', 'rev-one');
    const direct = await item('Direct item');
    const viaPr = await item('Item of the PR');
    const pr = await pullRequest(11, acme.projectId, [viaPr.id]);
    const statusOf = async (id: string) =>
      ok<{ summary: { status: string; counts: Record<string, number> } }>(
        await request('GET', `/api/v1/work-items/${id}/development`, as(acme.owner)),
      ).summary;
    expect((await statusOf(direct.id)).status).toBe('no_development');
    const created = await review({
      reviewerIds: [first.userId],
      workItemIds: [direct.id],
      pullRequestId: pr.id,
    });
    expect((await statusOf(direct.id)).status).toBe('pr_open');
    ok(await decide(created.id, first, 'approve'));
    expect((await statusOf(direct.id)).status).toBe('pr_approved');
    expect((await statusOf(viaPr.id)).status).toBe('pr_approved');
    // Reviews are not artifacts.
    expect((await statusOf(direct.id)).counts['pull_request']).toBe(0);
    const linked = ok<Array<{ id: string }>>(
      await request('GET', `/api/v1/work-items/${direct.id}/code-reviews`, as(acme.owner)),
    );
    expect(linked.map((entry) => entry.id)).toEqual([created.id]);
    expect((await get(created.id)).workItems.map((entry) => entry.id)).toEqual([direct.id]);
    const repeat = ok<{ created: boolean }>(
      await request(
        'POST',
        `/api/v1/code-reviews/${created.id}/work-items`,
        as(acme.owner, { workItemId: direct.id }),
      ),
    );
    expect(repeat.created).toBe(false);
    const chain = await owner.auditLog.findMany({
      where: { entityId: direct.id, summary: { startsWith: 'Development status of' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(
      chain.map(
        (log) => (log.changes as { developmentStatus: { to: string } }).developmentStatus.to,
      ),
    ).toEqual(['pr_open', 'pr_approved']);

    expect(
      (await request('DELETE', `/api/v1/code-reviews/${created.id}`, as(first))).statusCode,
    ).toBe(403);
    expect(
      (await request('DELETE', `/api/v1/code-reviews/${created.id}`, as(acme.owner))).statusCode,
    ).toBe(204);
    expect(
      (await request('GET', `/api/v1/code-reviews/${created.id}`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect((await decide(created.id, first, 'revoke')).statusCode).toBe(404);
    expect((await statusOf(direct.id)).status).toBe('no_development');
    expect((await statusOf(viaPr.id)).status).toBe('pr_open');
    const row = await owner.codeReview.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await owner.codeReviewEvent.count({ where: { reviewId: created.id } })).toBe(3);
  });
});
