import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  MemberPermissionsView,
  PERMISSIONS,
  Permission,
  PermissionOverrideInput,
  ROLE_PERMISSIONS,
} from '@qa-flow-hub/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('header says picture'),
]);

/**
 * Granular permissions: role defaults → project role → overrides → decision.
 *
 * Every test here drives the *public API* with a real token, never the service:
 * the property under test is that the backend refuses regardless of what the
 * client hides, so the client is exactly what is bypassed.
 */
describe('granular permissions', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;
  let admin: TestAccount;
  let manager: TestAccount;
  let lead: TestAccount;
  let tester: TestAccount;
  let viewer: TestAccount;

  const request = injector(() => app);

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
  });

  const mine = async (account: TestAccount, projectId = workspace.projectId) => {
    const response = await request(
      'GET',
      `/api/v1/projects/${projectId}/permissions/me`,
      as(account),
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<MemberPermissionsView>();
  };

  const granted = (view: MemberPermissionsView): Permission[] =>
    view.permissions.filter((entry) => entry.granted).map((entry) => entry.permission);

  const setOverrides = (
    actor: TestAccount,
    target: TestAccount,
    overrides: PermissionOverrideInput[],
    projectId = workspace.projectId,
    organizationId?: string,
  ) =>
    request(
      'PUT',
      `/api/v1/projects/${projectId}/permissions/members/${target.userId}`,
      as(actor, { overrides }, organizationId),
    );

  const createRequirement = (account: TestAccount, projectId = workspace.projectId) =>
    request(
      'POST',
      '/api/v1/requirements',
      as(account, { projectId, title: `Requirement ${Math.random()}` }),
    );

  const createSuite = (account: TestAccount, projectId = workspace.projectId) =>
    request('POST', '/api/v1/test-suites', as(account, { projectId, name: 'Smoke' }));

  const createDefect = (account: TestAccount) =>
    request(
      'POST',
      '/api/v1/defects',
      as(account, { projectId: workspace.projectId, title: 'Button does nothing' }),
    );

  const createRun = (account: TestAccount) =>
    request(
      'POST',
      '/api/v1/test-runs',
      as(account, { projectId: workspace.projectId, name: 'Regression' }),
    );

  const upload = (account: TestAccount, entityId: string) => {
    const boundary = 'qa-flow-hub-permissions';
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="shot.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/v1/attachments?entityType=defect&entityId=${entityId}`,
      payload: Buffer.concat([Buffer.from(head), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        'x-organization-id': workspace.organizationId,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  const configureJira = (account: TestAccount) =>
    request(
      'PUT',
      '/api/v1/integrations/jira',
      as(account, { mode: 'mock', baseUrl: 'https://acme.atlassian.net' }),
    );

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
    admin = await workspace.addMember('organization_admin');
    manager = await workspace.addMember('project_manager');
    lead = await workspace.addMember('qa_lead');
    tester = await workspace.addMember('tester');
    viewer = await workspace.addMember('viewer');
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('catalog', () => {
    it('publishes every permission with its module and each role’s defaults', async () => {
      const response = await request('GET', '/api/v1/permissions/catalog', as(viewer));
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        permissions: { permission: string }[];
        roles: typeof ROLE_PERMISSIONS;
      }>();
      expect(body.permissions.map((entry) => entry.permission)).toEqual([...PERMISSIONS]);
      expect(body.roles.organization_owner).toEqual([...PERMISSIONS]);
      expect(body.roles.viewer).not.toContain('requirements.write');
    });
  });

  describe('role defaults', () => {
    it('gives the owner every permission, sourced from ownership', async () => {
      const view = await mine(workspace.owner);
      expect(granted(view)).toEqual([...PERMISSIONS]);
      expect(new Set(view.permissions.map((entry) => entry.source))).toEqual(new Set(['owner']));
    });

    it.each([
      ['organization_admin', () => admin],
      ['project_manager', () => manager],
      ['qa_lead', () => lead],
      ['tester', () => tester],
      ['viewer', () => viewer],
    ] as const)('reports the %s defaults, sourced from the role', async (role, account) => {
      const view = await mine(account());
      expect(view.organizationRole).toBe(role);
      expect(view.projectRole).toBeNull();
      expect(view.effectiveRole).toBe(role);
      expect(granted(view).sort()).toEqual([...ROLE_PERMISSIONS[role]].sort());
      expect(new Set(view.permissions.map((entry) => entry.source))).toEqual(new Set(['role']));
    });

    it('lets an admin manage integrations and a manager not', async () => {
      expect((await configureJira(admin)).statusCode).toBe(200);
      expect((await configureJira(manager)).statusCode).toBe(403);
    });

    it('lets a qa_lead write requirements and plan runs but not delete runs', async () => {
      expect((await createRequirement(lead)).statusCode).toBe(201);
      const run = await createRun(lead);
      expect(run.statusCode).toBe(201);
      expect(
        (await request('DELETE', `/api/v1/test-runs/${run.json().id}`, as(lead))).statusCode,
      ).toBe(403);
      expect(
        (await request('DELETE', `/api/v1/test-runs/${run.json().id}`, as(manager))).statusCode,
      ).toBe(204);
    });

    it('lets a tester report defects and attach evidence but not write requirements', async () => {
      const defect = await createDefect(tester);
      expect(defect.statusCode).toBe(201);
      expect((await upload(tester, defect.json().id)).statusCode).toBe(201);
      expect((await createRequirement(tester)).statusCode).toBe(403);
      expect((await createSuite(tester)).statusCode).toBe(403);
    });

    it('keeps the viewer read-only across modules', async () => {
      expect((await createRequirement(viewer)).statusCode).toBe(403);
      expect((await createSuite(viewer)).statusCode).toBe(403);
      expect((await createDefect(viewer)).statusCode).toBe(403);
      expect((await createRun(viewer)).statusCode).toBe(403);
      expect((await configureJira(viewer)).statusCode).toBe(403);
      const defect = await createDefect(tester);
      expect((await upload(viewer, defect.json().id)).statusCode).toBe(403);

      expect(
        (await request('GET', `/api/v1/requirements?projectId=${workspace.projectId}`, as(viewer)))
          .statusCode,
      ).toBe(200);
      expect(
        (await request('GET', `/api/v1/defects?projectId=${workspace.projectId}`, as(viewer)))
          .statusCode,
      ).toBe(200);
      expect(
        (await request('GET', `/api/v1/projects/${workspace.projectId}/members`, as(viewer)))
          .statusCode,
      ).toBe(200);
    });
  });

  describe('overrides', () => {
    it('grants a viewer one permission in one project and the API honours it', async () => {
      expect((await createRequirement(viewer)).statusCode).toBe(403);

      const response = await setOverrides(manager, viewer, [
        { permission: 'requirements.write', effect: 'grant' },
      ]);
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json<MemberPermissionsView>();
      expect(view.overrides).toHaveLength(1);
      expect(view.overrides[0]?.grantedById).toBe(manager.userId);
      expect(
        view.permissions.find((entry) => entry.permission === 'requirements.write'),
      ).toMatchObject({ granted: true, source: 'override' });

      expect((await createRequirement(viewer)).statusCode).toBe(201);
      // Still a viewer everywhere else.
      expect((await createSuite(viewer)).statusCode).toBe(403);
      expect((await createDefect(viewer)).statusCode).toBe(403);
    });

    it('revokes a permission the role would otherwise give', async () => {
      expect((await createDefect(tester)).statusCode).toBe(201);

      const response = await setOverrides(manager, tester, [
        { permission: 'defects.create', effect: 'revoke' },
      ]);
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json<MemberPermissionsView>()
          .permissions.find((entry) => entry.permission === 'defects.create'),
      ).toMatchObject({ granted: false, source: 'override' });

      expect((await createDefect(tester)).statusCode).toBe(403);
      // The revoke is confined to defects: the tester still executes.
      expect(granted(await mine(tester))).toContain('testruns.execute');
    });

    it('applies on top of a project role, and replaces the previous set', async () => {
      // Tester leads QA in this project…
      await request(
        'POST',
        `/api/v1/projects/${workspace.projectId}/members`,
        as(manager, { userId: tester.userId, role: 'qa_lead' }),
      );
      expect((await createRequirement(tester)).statusCode).toBe(201);

      // …but is not allowed to write requirements here.
      await setOverrides(manager, tester, [{ permission: 'requirements.write', effect: 'revoke' }]);
      const view = await mine(tester);
      expect(view).toMatchObject({
        organizationRole: 'tester',
        projectRole: 'qa_lead',
        effectiveRole: 'qa_lead',
      });
      expect((await createRequirement(tester)).statusCode).toBe(403);
      expect((await createSuite(tester)).statusCode).toBe(201);

      // Replacing with an empty list clears everything.
      const cleared = await setOverrides(manager, tester, []);
      expect(cleared.json<MemberPermissionsView>().overrides).toEqual([]);
      expect((await createRequirement(tester)).statusCode).toBe(201);
    });

    it('rejects duplicate permissions in one request', async () => {
      const response = await setOverrides(manager, viewer, [
        { permission: 'defects.read', effect: 'grant' },
        { permission: 'defects.read', effect: 'revoke' },
      ]);
      expect(response.statusCode).toBe(400);
    });

    it('is audited without ever storing secrets', async () => {
      await setOverrides(manager, viewer, [{ permission: 'defects.create', effect: 'grant' }]);
      const entries = await prisma.auditLog.findMany({
        where: { entityType: 'ProjectPermissionOverride' },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.changes).toMatchObject({
        userId: viewer.userId,
        next: [{ permission: 'defects.create', effect: 'grant' }],
      });
    });
  });

  describe('escalation is refused', () => {
    it('never lets anybody edit their own overrides', async () => {
      const response = await setOverrides(manager, manager, [
        { permission: 'integrations.manage', effect: 'grant' },
      ]);
      expect(response.statusCode).toBe(403);
      // Not even an admin, and not even to take something away.
      expect(
        (await setOverrides(admin, admin, [{ permission: 'defects.manage', effect: 'revoke' }]))
          .statusCode,
      ).toBe(403);
    });

    it('only lets an actor grant what they effectively hold in this project', async () => {
      // A manager does not manage integrations, so cannot hand it out.
      const beyond = await setOverrides(manager, viewer, [
        { permission: 'integrations.manage', effect: 'grant' },
      ]);
      expect(beyond.statusCode).toBe(403);
      expect(beyond.json().error.message).toContain('integrations.manage');

      // An admin narrowed to tester in this project cannot grant above tester.
      await request(
        'POST',
        `/api/v1/projects/${workspace.projectId}/members`,
        as(workspace.owner, { userId: admin.userId, role: 'tester' }),
      );
      // …and has lost members.manage, so cannot edit overrides here at all.
      expect(
        (await setOverrides(admin, viewer, [{ permission: 'defects.read', effect: 'grant' }]))
          .statusCode,
      ).toBe(403);
    });

    it('does not let overrides act as a ladder: granting members.manage does not let you grant more', async () => {
      await setOverrides(manager, lead, [{ permission: 'members.manage', effect: 'grant' }]);
      // The lead may now edit overrides, but only from within their own set.
      expect(
        (await setOverrides(lead, viewer, [{ permission: 'requirements.write', effect: 'grant' }]))
          .statusCode,
      ).toBe(200);
      expect(
        (await setOverrides(lead, viewer, [{ permission: 'project.manage', effect: 'grant' }]))
          .statusCode,
      ).toBe(403);
      // And never upwards in rank: the lead cannot touch the manager.
      expect(
        (await setOverrides(lead, manager, [{ permission: 'defects.read', effect: 'revoke' }]))
          .statusCode,
      ).toBe(403);
    });

    it('refuses to touch an owner, whose access is total regardless', async () => {
      const response = await setOverrides(admin, workspace.owner, [
        { permission: 'requirements.read', effect: 'revoke' },
      ]);
      expect(response.statusCode).toBe(403);

      // Even a row planted directly is ignored by the resolver.
      await prisma.projectPermissionOverride.create({
        data: {
          organizationId: workspace.organizationId,
          projectId: workspace.projectId,
          userId: workspace.owner.userId,
          permission: 'requirements.write',
          effect: 'revoke',
        },
      });
      expect((await createRequirement(workspace.owner)).statusCode).toBe(201);
      expect(granted(await mine(workspace.owner))).toEqual([...PERMISSIONS]);
    });

    it('keeps the last owner protected: neither overrides nor role changes can lock them out', async () => {
      const demote = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${workspace.owner.userId}`,
        as(admin, { role: 'viewer' }),
      );
      expect(demote.statusCode).toBe(403);
      const remove = await request(
        'DELETE',
        `/api/v1/organizations/current/members/${workspace.owner.userId}`,
        as(admin),
      );
      expect(remove.statusCode).toBe(403);
      expect(
        (
          await setOverrides(admin, workspace.owner, [
            { permission: 'members.manage', effect: 'revoke' },
          ])
        ).statusCode,
      ).toBe(403);
      expect(granted(await mine(workspace.owner))).toEqual([...PERMISSIONS]);
    });

    it('answers 403 to a forced direct call even when the role would look plausible', async () => {
      await setOverrides(manager, lead, [{ permission: 'testruns.create', effect: 'revoke' }]);
      // The guard cannot know the project; the service must still say no.
      expect((await createRun(lead)).statusCode).toBe(403);
      // Reading needs members.read; a member without it is refused.
      await setOverrides(manager, viewer, [{ permission: 'members.read', effect: 'revoke' }]);
      expect(
        (
          await request(
            'GET',
            `/api/v1/projects/${workspace.projectId}/permissions/members/${tester.userId}`,
            as(viewer),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await request(
            'GET',
            `/api/v1/projects/${workspace.projectId}/permissions/overrides`,
            as(viewer),
          )
        ).statusCode,
      ).toBe(403);
    });
  });

  describe('isolation', () => {
    it('confines an override to its project', async () => {
      const other = await request(
        'POST',
        '/api/v1/projects',
        as(workspace.owner, { name: 'Mobile', key: 'MOB' }),
      );
      const otherProjectId: string = other.json().id;
      await request(
        'POST',
        `/api/v1/projects/${otherProjectId}/members`,
        as(workspace.owner, { userId: viewer.userId, role: null }),
      );

      await setOverrides(manager, viewer, [{ permission: 'requirements.write', effect: 'grant' }]);
      expect((await createRequirement(viewer)).statusCode).toBe(201);
      expect((await createRequirement(viewer, otherProjectId)).statusCode).toBe(403);
      expect(granted(await mine(viewer, otherProjectId))).not.toContain('requirements.write');
    });

    it('does not let a manager of one project edit overrides in another', async () => {
      const other = await request(
        'POST',
        '/api/v1/projects',
        as(workspace.owner, { name: 'Mobile', key: 'MOB' }),
      );
      const otherProjectId: string = other.json().id;
      // Manager is narrowed to viewer in MOB, so has no members.manage there.
      await request(
        'POST',
        `/api/v1/projects/${otherProjectId}/members`,
        as(workspace.owner, { userId: manager.userId, role: 'viewer' }),
      );

      expect(
        (
          await setOverrides(
            manager,
            viewer,
            [{ permission: 'defects.read', effect: 'grant' }],
            otherProjectId,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await setOverrides(manager, viewer, [{ permission: 'defects.read', effect: 'grant' }]))
          .statusCode,
      ).toBe(200);
    });

    it('never crosses organizations', async () => {
      const foreign = await createWorkspace(app, {
        emailPrefix: 'rival',
        slug: 'rival',
        projectKey: 'RIV',
      });
      const foreignViewer = await foreign.addMember('viewer');

      // Our manager cannot reach the foreign project, with either header.
      expect(
        (
          await setOverrides(
            manager,
            foreignViewer,
            [{ permission: 'defects.read', effect: 'grant' }],
            foreign.projectId,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await setOverrides(
            manager,
            foreignViewer,
            [{ permission: 'defects.read', effect: 'grant' }],
            foreign.projectId,
            foreign.organizationId,
          )
        ).statusCode,
      ).toBe(403);
      // A user known to both organizations cannot be granted here for there.
      expect(
        (
          await setOverrides(manager, foreignViewer, [
            { permission: 'defects.read', effect: 'grant' },
          ])
        ).statusCode,
      ).toBe(404);

      // A grant in our organization gives nothing in theirs.
      await setOverrides(manager, viewer, [{ permission: 'requirements.write', effect: 'grant' }]);
      expect(
        (
          await request(
            'GET',
            `/api/v1/projects/${foreign.projectId}/permissions/me`,
            as(viewer, undefined, foreign.organizationId),
          )
        ).statusCode,
      ).toBe(403);
      expect(await prisma.projectPermissionOverride.count()).toBe(1);
    });
  });
});
