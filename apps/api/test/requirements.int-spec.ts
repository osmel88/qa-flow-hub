import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

describe('requirements', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const createRequirement = (payload: object = {}) =>
    request('POST', '/api/v1/requirements', {
      payload: { projectId: workspace.projectId, title: 'The user can log in', ...payload },
      token: workspace.owner.accessToken,
      organizationId: workspace.organizationId,
    });

  const asOwner = { get token() { return workspace.owner.accessToken; } };

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

  describe('creation and keys', () => {
    it('assigns a readable key derived from the project', async () => {
      const first = await createRequirement();
      const second = await createRequirement({ title: 'The user can log out' });

      expect(first.json().key).toBe('WEB-R-1');
      expect(second.json().key).toBe('WEB-R-2');
    });

    it('numbers each project independently', async () => {
      await createRequirement();
      const otherProject = await request('POST', '/api/v1/projects', {
        payload: { name: 'Mobile', key: 'MOB' },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      const requirement = await createRequirement({ projectId: otherProject.json().id });

      expect(requirement.json().key).toBe('MOB-R-1');
    });

    it('refuses to attach a requirement to another organization’s project', async () => {
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const response = await request('POST', '/api/v1/requirements', {
        payload: { projectId: workspace.projectId, title: 'Sneaky' },
        token: stranger.owner.accessToken,
        organizationId: stranger.organizationId,
      });

      expect(response.statusCode).toBe(404);
    });

    it('does not burn a key when creation fails', async () => {
      await createRequirement();
      const failed = await request('POST', '/api/v1/requirements', {
        payload: { projectId: 'does-not-exist', title: 'Nope' },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });
      expect(failed.statusCode).toBe(404);

      const next = await createRequirement({ title: 'Second real one' });
      expect(next.json().key).toBe('WEB-R-2');
    });

    it('normalises tags and drops duplicates', async () => {
      const response = await createRequirement({ tags: ['Login', ' login ', 'AUTH'] });

      expect(response.json().tags).toEqual(['login', 'auth']);
    });

    it('starts in draft', async () => {
      expect((await createRequirement()).json().status).toBe('draft');
    });
  });

  describe('filters', () => {
    beforeEach(async () => {
      await createRequirement({ title: 'Login works', priority: 'critical', tags: ['auth'] });
      await createRequirement({ title: 'Logout works', priority: 'low', type: 'functional' });
      await createRequirement({ title: 'Export to CSV', type: 'epic', tags: ['reporting'] });
    });

    const list = (queryString: string) =>
      request('GET', `/api/v1/requirements?projectId=${workspace.projectId}&${queryString}`, {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

    it('filters by priority', async () => {
      expect((await list('priority=critical')).json().data).toHaveLength(1);
    });

    it('filters by type', async () => {
      expect((await list('type=epic')).json().data[0].title).toBe('Export to CSV');
    });

    it('filters by tag using the array column', async () => {
      const response = await list('tag=reporting');

      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0].tags).toContain('reporting');
    });

    it('searches by title case-insensitively and by key', async () => {
      expect((await list('search=LOGOUT')).json().data).toHaveLength(1);
      expect((await list('search=WEB-R-1')).json().data).toHaveLength(1);
    });

    it('requires a project, because a cross-project list has no meaning here', async () => {
      const response = await request('GET', '/api/v1/requirements', {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      expect(response.statusCode).toBe(400);
    });

    it('never returns another organization’s requirements', async () => {
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const response = await request(
        'GET',
        `/api/v1/requirements?projectId=${workspace.projectId}`,
        { token: stranger.owner.accessToken, organizationId: stranger.organizationId },
      );

      expect(response.json().data).toEqual([]);
    });
  });

  describe('status workflow', () => {
    const move = async (id: string, status: string) =>
      request('POST', `/api/v1/requirements/${id}/status`, {
        payload: { status },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

    it('walks draft → in_review → approved → implemented', async () => {
      const id = (await createRequirement()).json().id;

      expect((await move(id, 'in_review')).statusCode).toBe(200);
      expect((await move(id, 'approved')).statusCode).toBe(200);
      expect((await move(id, 'implemented')).json().status).toBe('implemented');
    });

    it('refuses to skip review', async () => {
      const id = (await createRequirement()).json().id;

      const response = await move(id, 'implemented');

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain('draft to implemented');
    });

    it('is a no-op when the status already matches', async () => {
      const id = (await createRequirement()).json().id;

      expect((await move(id, 'draft')).statusCode).toBe(200);
      const history = await request(`GET` as const, `/api/v1/requirements/${id}/history`, {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });
      expect(history.json()).toHaveLength(1);
    });

    it('records the transition in the audit log', async () => {
      const id = (await createRequirement()).json().id;
      await move(id, 'in_review');

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: id, entityType: 'Requirement', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry.changes).toMatchObject({ status: { from: 'draft', to: 'in_review' } });
    });

    it('does not let a qa_lead approve', async () => {
      const id = (await createRequirement()).json().id;
      const lead = await workspace.addMember('qa_lead');

      const response = await request('POST', `/api/v1/requirements/${id}/status`, {
        payload: { status: 'in_review' },
        token: lead.accessToken,
        organizationId: workspace.organizationId,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('history', () => {
    it('appends a version on creation and on every edit', async () => {
      const id = (await createRequirement()).json().id;

      await request('PATCH', `/api/v1/requirements/${id}`, {
        payload: { title: 'The user can log in with SSO' },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      const history = await request('GET', `/api/v1/requirements/${id}/history`, {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      expect(history.json()).toHaveLength(2);
      expect(history.json()[0]).toMatchObject({
        version: 2,
        snapshot: { title: 'The user can log in with SSO' },
      });
      expect(history.json()[1].snapshot.title).toBe('The user can log in');
    });

    it('keeps history after the requirement is deleted', async () => {
      const id = (await createRequirement()).json().id;
      await request('DELETE', `/api/v1/requirements/${id}`, {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      expect(await prisma.requirementVersion.count({ where: { requirementId: id } })).toBe(1);
    });

    it('hides a deleted requirement from reads', async () => {
      const id = (await createRequirement()).json().id;
      await request('DELETE', `/api/v1/requirements/${id}`, {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      const response = await request('GET', `/api/v1/requirements/${id}`, {
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('editing', () => {
    it('cannot move a requirement to another project', async () => {
      const id = (await createRequirement()).json().id;
      const other = await request('POST', '/api/v1/projects', {
        payload: { name: 'Mobile', key: 'MOB' },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      await request('PATCH', `/api/v1/requirements/${id}`, {
        payload: { title: 'Still fine', projectId: other.json().id },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id } });
      expect(requirement.projectId).toBe(workspace.projectId);
    });

    it('cannot change status through the update endpoint', async () => {
      const id = (await createRequirement()).json().id;

      // `status` is stripped by the schema, leaving an empty body, which the
      // schema then rejects. Either way the workflow endpoint is the only way
      // to move a requirement.
      const response = await request('PATCH', `/api/v1/requirements/${id}`, {
        payload: { status: 'approved' },
        token: asOwner.token,
        organizationId: workspace.organizationId,
      });

      expect(response.statusCode).toBe(400);
      const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id } });
      expect(requirement.status).toBe('draft');
    });

    it('does not let a tester edit', async () => {
      const id = (await createRequirement()).json().id;
      const tester = await workspace.addMember('tester');

      const response = await request('PATCH', `/api/v1/requirements/${id}`, {
        payload: { title: 'Changed' },
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('lets a tester read', async () => {
      const tester = await workspace.addMember('tester');

      const response = await request(
        'GET',
        `/api/v1/requirements?projectId=${workspace.projectId}`,
        { token: tester.accessToken, organizationId: workspace.organizationId },
      );

      expect(response.statusCode).toBe(200);
    });
  });
});
