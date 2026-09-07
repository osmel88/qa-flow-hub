import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { JiraMockStore } from '../src/integrations';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Requirement → Jira issue, Defect → Jira bug, over HTTP and against the mock.
 *
 * What these tests protect: the reference is created once and reused, a sync
 * needs a connected Jira and the permission to edit the entity, one
 * organization's issues are invisible to another, and a provider failure is
 * reported on the connection instead of swallowed.
 */
describe('jira synchronisation', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let store: JiraMockStore;
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

  const connectJira = async (settings: Record<string, string> = {}) => {
    await request(
      'PUT',
      '/api/v1/integrations/jira',
      asOwner({ mode: 'mock', baseUrl: 'https://acme.atlassian.net', settings }),
    );
    return request('POST', '/api/v1/integrations/jira/connect', asOwner());
  };

  const createRequirement = async (payload: object = {}) => {
    const response = await request('POST', '/api/v1/requirements', {
      ...asOwner({ projectId: workspace.projectId, title: 'The user can log in', ...payload }),
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const createDefect = async (payload: object = {}) => {
    const response = await request('POST', '/api/v1/defects', {
      ...asOwner({
        projectId: workspace.projectId,
        title: 'Card payment fails',
        severity: 'critical',
        priority: 'high',
        ...payload,
      }),
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const syncRequirement = (id: string, options = asOwner()) =>
    request('POST', `/api/v1/integrations/jira/sync/requirements/${id}`, options);
  const syncDefect = (id: string, options = asOwner()) =>
    request('POST', `/api/v1/integrations/jira/sync/defects/${id}`, options);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    store = app.get(JiraMockStore);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    store.reset();
    workspace = await createWorkspace(app);
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('browsing the mock', () => {
    it('lists deterministic projects, catalog and seed issues once connected', async () => {
      await connectJira();

      const projects = await request('GET', '/api/v1/integrations/jira/projects', asOwner());
      const catalog = await request('GET', '/api/v1/integrations/jira/catalog', asOwner());
      const bugs = await request('GET', '/api/v1/integrations/jira/issues?kind=bug', asOwner());

      expect(projects.json().map((project: { key: string }) => project.key)).toEqual(['QA', 'WEB']);
      expect(catalog.json().assignees).toHaveLength(3);
      expect(bugs.json()).toEqual([
        expect.objectContaining({ key: 'QA-2', externalId: '10101', kind: 'bug' }),
      ]);
    });

    it('refuses to browse before Jira is configured and connected', async () => {
      const unconfigured = await request('GET', '/api/v1/integrations/jira/projects', asOwner());
      expect(unconfigured.statusCode).toBe(409);
      expect(unconfigured.json().error.code).toBe('INTEGRATION_NOT_CONFIGURED');

      await request(
        'PUT',
        '/api/v1/integrations/jira',
        asOwner({ mode: 'mock', baseUrl: 'https://acme.atlassian.net' }),
      );
      const disconnected = await request('GET', '/api/v1/integrations/jira/projects', asOwner());
      expect(disconnected.statusCode).toBe(409);
      expect(disconnected.json().error.message).toContain('disconnected');
    });

    it('lets Test connection see the outage the settings ask for', async () => {
      await connectJira({ simulateFailure: 'unreachable' });

      const tested = await request('POST', '/api/v1/integrations/jira/test-connection', asOwner());

      expect(tested.json()).toMatchObject({ reachable: false, connection: { status: 'error' } });
      expect(tested.json().message).toContain('outage');

      await request('PUT', '/api/v1/integrations/jira', asOwner({ mode: 'mock', settings: {} }));
      const recovered = await request(
        'POST',
        '/api/v1/integrations/jira/test-connection',
        asOwner(),
      );
      expect(recovered.json()).toMatchObject({
        reachable: true,
        connection: { status: 'connected', lastError: null },
      });
    });
  });

  describe('requirement → issue', () => {
    it('creates a story on the first sync and updates it on the next', async () => {
      await connectJira();
      const requirement = await createRequirement({ priority: 'high', tags: ['auth'] });

      const first = await syncRequirement(requirement.id);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        entityType: 'requirement',
        entityId: requirement.id,
        action: 'created',
        reference: {
          provider: 'jira',
          externalId: '10103',
          externalKey: 'QA-3',
          externalUrl: 'https://acme.atlassian.net/browse/QA-3',
          metadata: { projectKey: 'QA', issueType: 'Story', priority: 'High' },
        },
        issue: {
          key: 'QA-3',
          kind: 'story',
          title: 'The user can log in',
          status: 'To Do',
          labels: expect.arrayContaining(['qa-flow-hub', 'origin:WEB-R-1', 'auth']),
        },
      });

      await request(
        'PATCH',
        `/api/v1/requirements/${requirement.id}`,
        asOwner({ title: 'The user can log in with SSO' }),
      );
      await request(
        'POST',
        `/api/v1/requirements/${requirement.id}/status`,
        asOwner({ status: 'in_review' }),
      );

      const second = await syncRequirement(requirement.id);
      expect(second.json()).toMatchObject({
        action: 'updated',
        reference: { id: first.json().reference.id, externalId: '10103' },
        issue: { title: 'The user can log in with SSO', status: 'In Review' },
      });

      const references = await prisma.externalReference.findMany({
        where: { organizationId: workspace.organizationId },
      });
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        entityType: 'requirement',
        entityId: requirement.id,
        provider: 'jira',
        externalId: '10103',
      });
    });

    it('recreates the issue when the provider has forgotten it, and keeps the trail', async () => {
      await connectJira();
      const requirement = await createRequirement();
      const first = (await syncRequirement(requirement.id)).json();

      // The provider no longer knows the issue: somebody deleted it there, or
      // the mock was restarted and re-seeded.
      await prisma.externalReference.update({
        where: { id: first.reference.id },
        data: { externalId: '99999', externalKey: 'QA-999' },
      });

      const second = (await syncRequirement(requirement.id)).json();
      expect(second.action).toBe('created');
      expect(second.reference).toMatchObject({
        id: first.reference.id,
        externalId: '10104',
        externalKey: 'QA-4',
        metadata: { previousExternalId: '99999' },
      });
      expect(await prisma.externalReference.count()).toBe(1);
    });

    it('puts the reference on the project list without a query per row', async () => {
      await connectJira();
      const synced = await createRequirement({ title: 'Synced' });
      await createRequirement({ title: 'Not synced' });
      await syncRequirement(synced.id);

      const references = await request(
        'GET',
        `/api/v1/integrations/jira/references?projectId=${workspace.projectId}&entityType=requirement`,
        asOwner(),
      );

      expect(references.statusCode).toBe(200);
      expect(references.json()).toEqual([
        expect.objectContaining({ entityId: synced.id, externalKey: 'QA-3' }),
      ]);
    });

    it('uses the project the connection is configured for', async () => {
      await connectJira({ projectKey: 'WEB' });
      const requirement = await createRequirement();

      const synced = await syncRequirement(requirement.id);

      expect(synced.json().reference.externalKey).toBe('WEB-2');
    });
  });

  describe('defect → bug', () => {
    it('creates a bug carrying severity and priority', async () => {
      await connectJira();
      const defect = await createDefect({ stepsToReproduce: '1. Pay with Visa' });

      const synced = await syncDefect(defect.id);

      expect(synced.statusCode).toBe(200);
      expect(synced.json()).toMatchObject({
        entityType: 'defect',
        action: 'created',
        reference: { externalKey: 'QA-3', metadata: { issueType: 'Bug', priority: 'High' } },
        issue: {
          kind: 'bug',
          title: 'Card payment fails',
          labels: expect.arrayContaining(['qa-flow-hub', 'origin:WEB-D-1', 'severity:critical']),
        },
      });

      const issue = store.findIssue(workspace.organizationId, synced.json().reference.externalId);
      expect(issue?.description).toContain('Steps to reproduce');
    });

    it('follows the defect through its lifecycle', async () => {
      await connectJira();
      const defect = await createDefect();
      await syncDefect(defect.id);

      await request('POST', `/api/v1/defects/${defect.id}/status`, asOwner({ status: 'triaged' }));
      await request(
        'POST',
        `/api/v1/defects/${defect.id}/status`,
        asOwner({ status: 'in_progress' }),
      );
      await request('POST', `/api/v1/defects/${defect.id}/status`, asOwner({ status: 'resolved' }));
      const synced = await syncDefect(defect.id);

      expect(synced.json()).toMatchObject({ action: 'updated', issue: { status: 'In Review' } });
      expect(
        await prisma.externalReference.count({
          where: { entityType: 'defect', entityId: defect.id },
        }),
      ).toBe(1);
    });

    it('keeps requirement and defect references apart even with the same issue key shape', async () => {
      await connectJira();
      const requirement = await createRequirement();
      const defect = await createDefect();

      const [story, bug] = await Promise.all([
        syncRequirement(requirement.id),
        syncDefect(defect.id),
      ]);

      const keys = [story.json().reference.externalKey, bug.json().reference.externalKey].sort();
      expect(keys).toEqual(['QA-3', 'QA-4']);
    });
  });

  describe('permissions and isolation', () => {
    it('never shows one organization the issues of another', async () => {
      await connectJira();
      const requirement = await createRequirement();
      await syncRequirement(requirement.id);

      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      await request('PUT', '/api/v1/integrations/jira', {
        payload: { mode: 'mock' },
        ...as(stranger.owner, stranger.organizationId),
      });
      await request(
        'POST',
        '/api/v1/integrations/jira/connect',
        as(stranger.owner, stranger.organizationId),
      );

      const theirIssues = await request(
        'GET',
        '/api/v1/integrations/jira/issues',
        as(stranger.owner, stranger.organizationId),
      );
      expect(theirIssues.json().map((issue: { key: string }) => issue.key)).toEqual([
        'QA-1',
        'QA-2',
        'WEB-1',
      ]);

      const theirSync = await syncRequirement(
        requirement.id,
        as(stranger.owner, stranger.organizationId),
      );
      expect(theirSync.statusCode).toBe(404);

      const theirReferences = await request(
        'GET',
        `/api/v1/integrations/jira/references?projectId=${workspace.projectId}&entityType=requirement`,
        as(stranger.owner, stranger.organizationId),
      );
      expect(theirReferences.statusCode).toBe(404);
    });

    it('lets whoever may edit the entity sync it, and nobody else', async () => {
      await connectJira();
      const viewer = await workspace.addMember('viewer');
      const tester = await workspace.addMember('tester');
      const requirement = await createRequirement();
      const defect = await createDefect();

      expect((await syncRequirement(requirement.id, as(viewer))).statusCode).toBe(403);
      expect((await syncRequirement(requirement.id, as(tester))).statusCode).toBe(403);
      expect((await syncDefect(defect.id, as(viewer))).statusCode).toBe(403);
      expect((await syncDefect(defect.id, as(tester))).statusCode).toBe(200);
    });

    it('applies a project-level role narrowing to the sync', async () => {
      await connectJira();
      const lead = await workspace.addMember('qa_lead');
      const requirement = await createRequirement();

      await request(
        'POST',
        `/api/v1/projects/${workspace.projectId}/members`,
        asOwner({ userId: lead.userId, role: 'viewer' }),
      );

      expect((await syncRequirement(requirement.id, as(lead))).statusCode).toBe(403);
    });
  });

  describe('provider failures', () => {
    it('reports a simulated write failure and marks the connection', async () => {
      await connectJira({ simulateFailure: 'write_failure' });
      const requirement = await createRequirement();

      const synced = await syncRequirement(requirement.id);

      expect(synced.statusCode).toBe(502);
      expect(synced.json().error.code).toBe('INTEGRATION_ERROR');
      expect(synced.json().error.message).toContain('refused the write');

      const connection = (await request('GET', '/api/v1/integrations/jira', asOwner())).json();
      expect(connection).toMatchObject({ status: 'error' });
      expect(connection.lastError).toContain('refused the write');
      expect(await prisma.externalReference.count()).toBe(0);
    });

    it('refuses to sync into a project the mock does not have', async () => {
      await connectJira({ projectKey: 'NOPE' });
      const defect = await createDefect();

      const synced = await syncDefect(defect.id);

      expect(synced.statusCode).toBe(502);
      expect(synced.json().error.message).toContain('NOPE');
    });

    it('clears the error once a sync succeeds again', async () => {
      await connectJira({ simulateFailure: 'unreachable' });
      const requirement = await createRequirement();
      expect((await syncRequirement(requirement.id)).statusCode).toBe(502);

      await request('PUT', '/api/v1/integrations/jira', asOwner({ mode: 'mock', settings: {} }));
      const synced = await syncRequirement(requirement.id);

      expect(synced.statusCode).toBe(200);
      const connection = (await request('GET', '/api/v1/integrations/jira', asOwner())).json();
      expect(connection).toMatchObject({ status: 'connected', lastError: null });
      expect(connection.lastSyncAt).not.toBeNull();
    });
  });
});
