import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { GitHubMockStore, JiraMockStore, TestRailMockStore } from '../src/integrations';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

interface Row {
  referenceId: string | null;
  entityType: string;
  entityId: string;
  entityKey: string | null;
  entityState: string;
  provider: string;
  externalKind: string;
  externalId: string | null;
  previousExternalId: string | null;
  status: string;
  issues: string[];
  lastSyncAt: string | null;
  lastVerifiedAt: string | null;
  error: string | null;
  canResync: boolean;
}

interface View {
  projectId: string;
  counts: Record<string, number>;
  providers: Array<{ provider: string; configured: boolean; connectionStatus: string | null }>;
  rows: Row[];
}

/**
 * One table for every link a project holds into Jira, TestRail and GitHub.
 *
 * What these tests protect: the view is project-scoped and tenant-scoped, the
 * status of a row is derived from the reference, its entity and its
 * connection without being stored anywhere, a lost external object is found
 * by verification and repaired by the existing re-sync, deleted and archived
 * entities are shown rather than hidden, and duplicates are reported instead
 * of silently collapsed.
 */
describe('external traceability', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jira: JiraMockStore;
  let testrail: TestRailMockStore;
  let github: GitHubMockStore;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const asOwner = (payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: workspace.owner.accessToken,
    organizationId: workspace.organizationId,
  });

  const as = (account: TestAccount, organizationId = workspace.organizationId) => ({
    token: account.accessToken,
    organizationId,
  });

  const connect = async (provider: string, settings: Record<string, string> = {}) => {
    const put = await request(
      'PUT',
      `/api/v1/integrations/${provider}`,
      asOwner({ mode: 'mock', baseUrl: `https://acme.${provider}.test`, settings }),
    );
    expect(put.statusCode, put.body).toBe(200);
    const connected = await request('POST', `/api/v1/integrations/${provider}/connect`, asOwner());
    expect(connected.statusCode, connected.body).toBe(200);
  };

  const view = async (query = '', options = asOwner()): Promise<View> => {
    const response = await request(
      'GET',
      `/api/v1/integrations/traceability?projectId=${workspace.projectId}${query}`,
      options,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };

  const verify = (options = asOwner({ projectId: '' })) =>
    request('POST', '/api/v1/integrations/traceability/verify', {
      ...options,
      payload: { projectId: workspace.projectId },
    });

  const rowFor = (rows: Row[], provider: string, entityType: string, entityId: string): Row => {
    const row = rows.find(
      (entry) =>
        entry.provider === provider &&
        entry.entityType === entityType &&
        entry.entityId === entityId,
    );
    expect(row, `${provider}/${entityType}/${entityId}`).toBeDefined();
    return row as Row;
  };

  const created = async (path: string, payload: object) => {
    const response = await request('POST', path, asOwner(payload));
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };

  const createRequirement = (title = 'The user can log in') =>
    created('/api/v1/requirements', { projectId: workspace.projectId, title });
  const createDefect = () =>
    created('/api/v1/defects', {
      projectId: workspace.projectId,
      title: 'Card payment fails',
      severity: 'critical',
      priority: 'high',
    });
  const createSuite = (name = 'Checkout') =>
    created('/api/v1/test-suites', { projectId: workspace.projectId, name });
  const createCase = (suiteId: string, title = 'Pay with a card') =>
    created('/api/v1/test-cases', {
      suiteId,
      title,
      priority: 'high',
      type: 'regression',
      steps: [{ action: 'Pay', expectedResult: 'Paid' }],
    });
  const createRun = (testCaseIds: string[], name = 'Nightly') =>
    created('/api/v1/test-runs', {
      projectId: workspace.projectId,
      name,
      environment: 'ci',
      selection: { testCaseIds },
    });

  const sync = async (path: string, options = asOwner()) => {
    const response = await request('POST', `/api/v1/integrations/${path}`, options);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    jira = app.get(JiraMockStore);
    testrail = app.get(TestRailMockStore);
    github = app.get(GitHubMockStore);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    jira.reset();
    testrail.reset();
    github.reset();
    workspace = await createWorkspace(app);
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('consolidating the three providers', () => {
    it('lists Jira, TestRail and GitHub references of a project in one view, with the project stamped on each', async () => {
      await connect('jira');
      await connect('testrail');
      await connect('github');
      const requirement = await createRequirement();
      const defect = await createDefect();
      const suite = await createSuite();
      const testCase = await createCase(suite.id);
      const run = await createRun([testCase.id]);

      await sync(`jira/sync/requirements/${requirement.id}`);
      await sync(`jira/sync/defects/${defect.id}`);
      await sync(`testrail/sync/test-runs/${run.id}`);
      await sync(
        `github/sync/test-runs/${run.id}`,
        asOwner({ repositoryExternalId: '1', runExternalId: '1001' }),
      );

      const result = await view('&includeMissing=false');
      expect(
        result.rows.map((row) => `${row.provider}:${row.entityType}:${row.externalKind}`),
      ).toEqual([
        'jira:requirement:issue',
        'jira:defect:bug',
        'testrail:test_suite:suite',
        'testrail:test_case:case',
        'github:test_run:workflow_run',
        'testrail:test_run:run',
      ]);
      expect(result.rows.every((row) => row.status === 'synced')).toBe(true);
      expect(result.counts).toMatchObject({ synced: 6, missing: 0, stale: 0, error: 0 });
      expect(rowFor(result.rows, 'jira', 'requirement', requirement.id)).toMatchObject({
        entityKey: requirement.key,
        externalId: '10103',
        canResync: true,
      });

      const stored = await prisma.externalReference.findMany({
        where: { organizationId: workspace.organizationId },
      });
      expect(stored).toHaveLength(6);
      expect(stored.every((reference) => reference.projectId === workspace.projectId)).toBe(true);
    });

    it('includes imported automated results, linked to their workflow run and not re-syncable one by one', async () => {
      await connect('github');
      const suite = await createSuite();
      const testCase = await createCase(suite.id);
      const run = await createRun([testCase.id]);
      await sync(
        `github/sync/test-runs/${run.id}`,
        asOwner({ repositoryExternalId: '1', runExternalId: '1001' }),
      );
      const imported = await sync(`github/sync/test-runs/${run.id}/results`);
      expect(imported.imported.length).toBe(1);

      const result = await view('&provider=github');
      const results = result.rows.filter((row) => row.entityType === 'test_result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        externalKind: 'automated_test',
        status: 'synced',
        canResync: false,
        entityKey: expect.stringContaining(testCase.key) as unknown,
      });
    });

    it('filters by provider, entity type and status', async () => {
      await connect('jira');
      await connect('testrail');
      const requirement = await createRequirement();
      await createDefect();
      const suite = await createSuite();
      await sync(`jira/sync/requirements/${requirement.id}`);

      const jiraOnly = await view('&provider=jira');
      expect(jiraOnly.rows.every((row) => row.provider === 'jira')).toBe(true);
      expect(jiraOnly.counts).toMatchObject({ synced: 1, missing: 1 });

      const suites = await view('&entityType=test_suite');
      expect(suites.rows).toEqual([
        expect.objectContaining({ provider: 'testrail', entityId: suite.id, status: 'missing' }),
      ]);

      const missing = await view('&status=missing');
      expect(missing.rows.every((row) => row.status === 'missing')).toBe(true);
      expect(missing.rows.map((row) => `${row.provider}:${row.entityType}`).sort()).toEqual([
        'jira:defect',
        'testrail:test_suite',
      ]);
    });

    it('reports a missing link only for providers that are connected', async () => {
      await createRequirement();
      expect((await view()).rows).toEqual([]);

      await connect('jira');
      expect((await view()).rows).toEqual([
        expect.objectContaining({ provider: 'jira', status: 'missing', issues: ['not_linked'] }),
      ]);

      await request('POST', '/api/v1/integrations/jira/disconnect', asOwner());
      expect((await view()).rows).toEqual([]);
    });
  });

  describe('deriving the status', () => {
    it('turns synced into stale when the entity changes after the last sync', async () => {
      await connect('jira');
      const requirement = await createRequirement();
      await sync(`jira/sync/requirements/${requirement.id}`);
      expect(rowFor((await view()).rows, 'jira', 'requirement', requirement.id).status).toBe(
        'synced',
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      const patched = await request(
        'PATCH',
        `/api/v1/requirements/${requirement.id}`,
        asOwner({ title: 'The user can log in with SSO' }),
      );
      expect(patched.statusCode).toBe(200);

      const stale = rowFor((await view()).rows, 'jira', 'requirement', requirement.id);
      expect(stale).toMatchObject({ status: 'stale', issues: ['entity_changed'] });

      await sync(`jira/sync/requirements/${requirement.id}`);
      expect(rowFor((await view()).rows, 'jira', 'requirement', requirement.id).status).toBe(
        'synced',
      );
    });

    it('shows soft-deleted and archived entities as stale rather than dropping them', async () => {
      await connect('testrail');
      const suite = await createSuite();
      const kept = await createCase(suite.id, 'Kept');
      const archived = await createCase(suite.id, 'Archived');
      await sync(`testrail/sync/test-cases/${kept.id}`);
      await sync(`testrail/sync/test-cases/${archived.id}`);
      const defectSuite = await createSuite('Doomed');
      await sync(`testrail/sync/test-suites/${defectSuite.id}`);

      expect(
        (await request('POST', `/api/v1/test-cases/${archived.id}/archive`, asOwner())).statusCode,
      ).toBe(200);
      expect(
        (await request('DELETE', `/api/v1/test-suites/${defectSuite.id}`, asOwner())).statusCode,
      ).toBe(204);

      const rows = (await view()).rows;
      expect(rowFor(rows, 'testrail', 'test_case', kept.id).status).toBe('synced');
      expect(rowFor(rows, 'testrail', 'test_case', archived.id)).toMatchObject({
        status: 'stale',
        entityState: 'archived',
        issues: ['archived_entity'],
      });
      expect(rowFor(rows, 'testrail', 'test_suite', defectSuite.id)).toMatchObject({
        status: 'stale',
        entityState: 'deleted',
        issues: ['deleted_entity'],
        entityKey: 'Doomed',
      });
      // A deleted entity is no longer expected to be linked anywhere.
      expect(rows.filter((row) => row.status === 'missing')).toEqual([]);
    });

    it('flags a reference whose entity is gone as orphaned', async () => {
      await connect('jira');
      const requirement = await createRequirement();
      const synced = await sync(`jira/sync/requirements/${requirement.id}`);
      await prisma.externalReference.update({
        where: { id: synced.reference.id },
        data: { entityId: 'req_that_never_existed' },
      });

      const row = rowFor((await view()).rows, 'jira', 'requirement', 'req_that_never_existed');
      expect(row).toMatchObject({
        status: 'error',
        entityState: 'missing',
        entityKey: null,
        issues: ['orphaned_entity'],
        canResync: false,
      });
    });

    it('reports duplicates instead of collapsing them', async () => {
      await connect('jira');
      const first = await createRequirement('First');
      const second = await createRequirement('Second');
      const a = await sync(`jira/sync/requirements/${first.id}`);
      const b = await sync(`jira/sync/requirements/${second.id}`);

      // Two references for the same entity: the constraint allows it because
      // the external ids differ, and only the view can tell it is wrong.
      await prisma.externalReference.create({
        data: {
          organizationId: workspace.organizationId,
          projectId: workspace.projectId,
          provider: 'jira',
          entityType: 'requirement',
          entityId: first.id,
          externalId: '77777',
          externalKey: 'QA-777',
          connectionId: a.reference.connectionId,
          metadata: { syncedAt: new Date().toISOString() },
        },
      });
      // Two entities pointing at the same external issue.
      await prisma.externalReference.update({
        where: { id: b.reference.id },
        data: { externalId: a.reference.externalId, externalKey: a.reference.externalKey },
      });

      const rows = (await view()).rows.filter((row) => row.provider === 'jira');
      const firstRows = rows.filter((row) => row.entityId === first.id);
      expect(firstRows).toHaveLength(2);
      for (const row of firstRows) {
        expect(row.status).toBe('error');
        expect(row.issues).toContain('duplicate_reference');
      }
      expect(rowFor(rows, 'jira', 'requirement', second.id).issues).toEqual(['shared_external_id']);
      expect(firstRows.filter((row) => row.issues.includes('shared_external_id'))).toHaveLength(1);
    });

    it('paints every row of a provider in error when its connection is, and clears it on the next sync', async () => {
      await connect('jira');
      const requirement = await createRequirement();
      await sync(`jira/sync/requirements/${requirement.id}`);

      await request(
        'PUT',
        '/api/v1/integrations/jira',
        asOwner({ mode: 'mock', settings: { simulateFailure: 'unreachable' } }),
      );
      const failed = await request(
        'POST',
        `/api/v1/integrations/jira/sync/requirements/${requirement.id}`,
        asOwner(),
      );
      expect(failed.statusCode).toBe(502);

      const broken = await view();
      expect(broken.providers.find((p) => p.provider === 'jira')?.connectionStatus).toBe('error');
      expect(rowFor(broken.rows, 'jira', 'requirement', requirement.id)).toMatchObject({
        status: 'error',
        issues: ['connection_error'],
        error: expect.stringContaining('unreachable') as unknown,
      });

      await request('PUT', '/api/v1/integrations/jira', asOwner({ mode: 'mock', settings: {} }));
      await sync(`jira/sync/requirements/${requirement.id}`);
      expect(rowFor((await view()).rows, 'jira', 'requirement', requirement.id).status).toBe(
        'synced',
      );
    });

    it('marks references as linked, not synced, while the provider is disconnected', async () => {
      await connect('testrail');
      const suite = await createSuite();
      await sync(`testrail/sync/test-suites/${suite.id}`);
      await request('POST', '/api/v1/integrations/testrail/disconnect', asOwner());

      expect(rowFor((await view()).rows, 'testrail', 'test_suite', suite.id)).toMatchObject({
        status: 'linked',
        issues: ['connection_disabled'],
      });
    });

    it('keeps a GitHub link to a running workflow as linked and a finished one as synced', async () => {
      await connect('github');
      const suite = await createSuite();
      const testCase = await createCase(suite.id);
      const run = await createRun([testCase.id]);
      await sync(
        `github/sync/test-runs/${run.id}`,
        asOwner({ repositoryExternalId: '1', runExternalId: '1003' }),
      );
      expect(rowFor((await view()).rows, 'github', 'test_run', run.id).status).toBe('linked');

      const relinked = await sync(
        `github/sync/test-runs/${run.id}`,
        asOwner({ repositoryExternalId: '1', runExternalId: '1001' }),
      );
      expect(relinked.action).toBe('updated');
      expect(rowFor((await view()).rows, 'github', 'test_run', run.id)).toMatchObject({
        status: 'synced',
        externalId: '1001',
        previousExternalId: '1003',
      });
    });
  });

  describe('verifying against the providers', () => {
    it('finds external objects the providers have lost and lets the existing re-sync repair them', async () => {
      await connect('jira');
      await connect('testrail');
      await connect('github');
      const defect = await createDefect();
      const requirement = await createRequirement();
      const suite = await createSuite();
      const testCase = await createCase(suite.id);
      const run = await createRun([testCase.id]);
      await sync(`jira/sync/defects/${defect.id}`);
      const issue = await sync(`jira/sync/requirements/${requirement.id}`);
      expect(issue.reference.externalId).toBe('10104');
      await sync(`testrail/sync/test-cases/${testCase.id}`);
      await sync(
        `github/sync/test-runs/${run.id}`,
        asOwner({ repositoryExternalId: '1', runExternalId: '1001' }),
      );

      // Jira forgets everything (restart), GitHub expires one run; TestRail keeps its data.
      jira.reset(workspace.organizationId);
      github.forgetWorkflowRun(workspace.organizationId, '1001');

      const verified = await verify();
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({ checked: 5, present: 2, lost: 3, failed: [] });

      const rows = (await view()).rows;
      expect(rowFor(rows, 'jira', 'requirement', requirement.id)).toMatchObject({
        status: 'stale',
        issues: ['provider_lost'],
        lastVerifiedAt: expect.any(String) as unknown,
      });
      expect(rowFor(rows, 'github', 'test_run', run.id)).toMatchObject({
        status: 'stale',
        issues: ['provider_lost'],
      });
      expect(rowFor(rows, 'testrail', 'test_case', testCase.id)).toMatchObject({
        status: 'synced',
        issues: [],
        lastVerifiedAt: expect.any(String) as unknown,
      });

      const repaired = await sync(`jira/sync/requirements/${requirement.id}`);
      expect(repaired.action).toBe('created');
      expect(rowFor((await view()).rows, 'jira', 'requirement', requirement.id)).toMatchObject({
        status: 'synced',
        externalId: '10103',
        previousExternalId: issue.reference.externalId,
        lastVerifiedAt: null,
      });
      expect(
        await prisma.externalReference.count({
          where: { entityId: requirement.id, provider: 'jira' },
        }),
      ).toBe(1);
    });

    it('isolates a provider failure: the others are still verified and the failing connection records the error', async () => {
      await connect('jira');
      await connect('testrail');
      const requirement = await createRequirement();
      const suite = await createSuite();
      await sync(`jira/sync/requirements/${requirement.id}`);
      await sync(`testrail/sync/test-suites/${suite.id}`);
      await request(
        'PUT',
        '/api/v1/integrations/jira',
        asOwner({ mode: 'mock', settings: { simulateFailure: 'unreachable' } }),
      );

      const verified = (await verify()).json();
      expect(verified).toMatchObject({ checked: 1, present: 1, lost: 0 });
      expect(verified.failed).toEqual([
        { provider: 'jira', error: expect.stringContaining('unreachable') as unknown },
      ]);

      const rows = (await view()).rows;
      expect(rowFor(rows, 'jira', 'requirement', requirement.id).status).toBe('error');
      expect(rowFor(rows, 'testrail', 'test_suite', suite.id).lastVerifiedAt).toEqual(
        expect.any(String),
      );
    });
  });

  describe('tenancy and permissions', () => {
    it('never shows another organization its references, even for the same project id', async () => {
      await connect('jira');
      const requirement = await createRequirement();
      await sync(`jira/sync/requirements/${requirement.id}`);

      const other = await createWorkspace(app, { emailPrefix: 'other', slug: 'other-org' });
      const foreign = await request(
        'GET',
        `/api/v1/integrations/traceability?projectId=${workspace.projectId}`,
        as(other.owner, other.organizationId),
      );
      expect(foreign.statusCode).toBe(404);

      const own = await request(
        'GET',
        `/api/v1/integrations/traceability?projectId=${other.projectId}`,
        as(other.owner, other.organizationId),
      );
      expect(own.statusCode).toBe(200);
      expect(own.json().rows).toEqual([]);
    });

    it('lets any project member read, and only planning roles verify — as narrowed per project', async () => {
      await connect('jira');
      const requirement = await createRequirement();
      await sync(`jira/sync/requirements/${requirement.id}`);
      const tester = await workspace.addMember('tester', 'tester');
      const lead = await workspace.addMember('qa_lead', 'lead');
      const narrowed = await request(
        'POST',
        `/api/v1/projects/${workspace.projectId}/members`,
        asOwner({ userId: lead.userId, role: 'viewer' }),
      );
      expect(narrowed.statusCode, narrowed.body).toBe(201);

      const read = await request(
        'GET',
        `/api/v1/integrations/traceability?projectId=${workspace.projectId}`,
        as(tester),
      );
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().rows).toHaveLength(1);

      expect((await verify(as(tester))).statusCode).toBe(403);
      // An organization qa_lead may verify anywhere — except where a project grant made them a viewer.
      expect((await verify(as(lead))).statusCode).toBe(403);
      expect((await verify()).statusCode).toBe(200);
    });

    it('rejects an unknown project and malformed filters', async () => {
      expect(
        (await request('GET', '/api/v1/integrations/traceability?projectId=nope', asOwner()))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await request(
            'GET',
            `/api/v1/integrations/traceability?projectId=${workspace.projectId}&status=weird`,
            asOwner(),
          )
        ).statusCode,
      ).toBe(400);
    });
  });
});
