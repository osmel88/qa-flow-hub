import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Settings → Integrations over HTTP.
 *
 * The tests worth having here are the ones that protect a promise rather than a
 * shape: no credential ever leaves the API, one organization cannot see or edit
 * another's connections, only owners and admins can write, and a provider with
 * no implementation says so instead of reporting itself connected.
 */
describe('integration settings', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const asOwner = (payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: workspace.owner.accessToken,
    organizationId: workspace.organizationId,
  });

  const configureJira = (payload: object = {}) =>
    request(
      'PUT',
      '/api/v1/integrations/jira',
      asOwner({ mode: 'mock', baseUrl: 'https://acme.atlassian.net', ...payload }),
    );

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

  describe('listing', () => {
    it('lists the three providers before anything is configured', async () => {
      const response = await request('GET', '/api/v1/integrations', asOwner());

      expect(response.statusCode).toBe(200);
      const providers = response.json();
      expect(providers.map((provider: { provider: string }) => provider.provider)).toEqual([
        'jira',
        'testrail',
        'github',
      ]);
      expect(providers.every((provider: { id: string | null }) => provider.id === null)).toBe(true);
      expect(
        providers.every(
          (provider: { status: string; enabled: boolean }) =>
            provider.status === 'disconnected' && !provider.enabled,
        ),
      ).toBe(true);
    });

    it('states which modes each provider accepts and why the rest are refused', async () => {
      const providers = (await request('GET', '/api/v1/integrations', asOwner())).json();
      const byProvider = new Map<string, { availableModes: string[]; unavailableReason: string }>(
        providers.map((provider: { provider: string }) => [provider.provider, provider]),
      );

      expect(byProvider.get('jira')?.availableModes).toEqual(['mock']);
      expect(byProvider.get('testrail')?.availableModes).toEqual(['mock']);
      // GitHub is the one provider meant to be real, and the one that cannot
      // connect yet: the credential store arrives with S2-F4.
      expect(byProvider.get('github')?.availableModes).toEqual(['real']);
      expect(byProvider.get('github')?.unavailableReason).toContain('S2-F4');
    });

    it('rejects a provider that is not configurable', async () => {
      const response = await request('GET', '/api/v1/integrations/slack', asOwner());

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('configuration', () => {
    it('creates on the first save and edits on the second', async () => {
      const created = await configureJira();
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        provider: 'jira',
        mode: 'mock',
        enabled: false,
        status: 'disconnected',
        baseUrl: 'https://acme.atlassian.net',
      });

      const edited = await configureJira({
        displayName: 'Jira Cloud',
        settings: { projectKey: 'WEB' },
      });
      expect(edited.json()).toMatchObject({
        id: created.json().id,
        displayName: 'Jira Cloud',
        settings: { projectKey: 'WEB' },
      });

      const stored = await prisma.integrationConnection.findMany({
        where: { organizationId: workspace.organizationId },
      });
      expect(stored).toHaveLength(1);
    });

    it('drops a base URL for a provider that has no use for one', async () => {
      const response = await request(
        'PUT',
        '/api/v1/integrations/github',
        asOwner({ mode: 'real', baseUrl: 'https://github.example.test' }),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json().baseUrl).toBeNull();
    });

    it('refuses a mode the provider does not support yet', async () => {
      const response = await request('PUT', '/api/v1/integrations/jira', asOwner({ mode: 'real' }));

      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].message).toContain('mock');
    });

    it('refuses to store a credential in the non-sensitive configuration', async () => {
      const response = await configureJira({ settings: { apiToken: 'super-secret' } });

      expect(response.statusCode).toBe(400);
    });

    it('never returns a credential, only whether one exists', async () => {
      const created = (await configureJira()).json();
      expect(created.hasCredential).toBe(false);
      expect(JSON.stringify(created)).not.toContain('secretRef');

      // Simulates the credential a later phase will store: the reference is
      // internal and the API must reduce it to a boolean.
      await prisma.integrationConnection.update({
        where: { id: created.id },
        data: { secretRef: 'vault://organizations/acme/jira' },
      });

      const reloaded = (await request('GET', '/api/v1/integrations/jira', asOwner())).json();
      expect(reloaded.hasCredential).toBe(true);
      expect(JSON.stringify(reloaded)).not.toContain('vault://');
    });
  });

  describe('connect, disconnect and test connection', () => {
    it('connects a provider that has an implementation', async () => {
      await configureJira();

      const connected = await request('POST', '/api/v1/integrations/jira/connect', asOwner());

      expect(connected.statusCode).toBe(200);
      expect(connected.json()).toMatchObject({
        enabled: true,
        status: 'connected',
        lastError: null,
      });
    });

    it('leaves an enabled connection pending while no provider answers', async () => {
      await request(
        'PUT',
        '/api/v1/integrations/testrail',
        asOwner({ mode: 'mock', baseUrl: 'https://acme.testrail.io' }),
      );

      const connected = await request('POST', '/api/v1/integrations/testrail/connect', asOwner());

      expect(connected.statusCode).toBe(200);
      expect(connected.json()).toMatchObject({ enabled: true, status: 'pending', lastError: null });
    });

    it('refuses to connect a provider that was never configured', async () => {
      const response = await request('POST', '/api/v1/integrations/testrail/connect', asOwner());

      expect(response.statusCode).toBe(404);
    });

    it('keeps the configuration and clears the credential reference on disconnect', async () => {
      const created = (await configureJira({ settings: { projectKey: 'WEB' } })).json();
      await prisma.integrationConnection.update({
        where: { id: created.id },
        data: { secretRef: 'vault://organizations/acme/jira' },
      });
      await request('POST', '/api/v1/integrations/jira/connect', asOwner());

      const disconnected = await request('POST', '/api/v1/integrations/jira/disconnect', asOwner());

      expect(disconnected.json()).toMatchObject({
        enabled: false,
        status: 'disconnected',
        hasCredential: false,
        settings: { projectKey: 'WEB' },
        baseUrl: 'https://acme.atlassian.net',
      });
      const stored = await prisma.integrationConnection.findUnique({ where: { id: created.id } });
      expect(stored?.secretRef).toBeNull();
      expect(stored?.deletedAt).toBeNull();
    });

    it('reports unreachable and records when it was asked', async () => {
      await request(
        'PUT',
        '/api/v1/integrations/testrail',
        asOwner({ mode: 'mock', baseUrl: 'https://acme.testrail.io' }),
      );

      const tested = await request(
        'POST',
        '/api/v1/integrations/testrail/test-connection',
        asOwner(),
      );

      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({ provider: 'testrail', reachable: false });
      expect(tested.json().message).toContain('S2-F3');
      expect(tested.json().connection.lastConnectionTestAt).not.toBeNull();
    });

    it('says GitHub needs S2-F4 instead of pretending to reach it', async () => {
      await request('PUT', '/api/v1/integrations/github', asOwner({ mode: 'real' }));

      const tested = await request(
        'POST',
        '/api/v1/integrations/github/test-connection',
        asOwner(),
      );

      expect(tested.json().reachable).toBe(false);
      expect(tested.json().message).toContain('S2-F4');
      expect(tested.json().connection.status).toBe('disconnected');
    });

    it('audits every state change without the credential', async () => {
      await configureJira();
      await request('POST', '/api/v1/integrations/jira/connect', asOwner());
      await request('POST', '/api/v1/integrations/jira/disconnect', asOwner());

      const entries = await prisma.auditLog.findMany({
        where: { entityType: 'IntegrationConnection' },
        orderBy: { createdAt: 'asc' },
      });

      expect(entries.map((entry) => entry.action)).toEqual(['create', 'update', 'update']);
      expect(JSON.stringify(entries)).not.toContain('secretRef');
    });
  });

  describe('permissions and isolation', () => {
    it.each([
      ['tester', 'PUT', '/api/v1/integrations/jira'],
      ['tester', 'POST', '/api/v1/integrations/jira/connect'],
      ['viewer', 'PUT', '/api/v1/integrations/jira'],
      ['viewer', 'POST', '/api/v1/integrations/jira/test-connection'],
    ] as const)('refuses a %s writing with %s %s', async (role, method, url) => {
      const member = await workspace.addMember(role);

      const response = await request(method, url, {
        payload: { mode: 'mock' },
        token: member.accessToken,
        organizationId: workspace.organizationId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('lets any member read the configuration, which carries no secret', async () => {
      await configureJira();
      const viewer = await workspace.addMember('viewer');

      const response = await request('GET', '/api/v1/integrations', {
        token: viewer.accessToken,
        organizationId: workspace.organizationId,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].hasCredential).toBe(false);
    });

    it('does not leak a connection across organizations', async () => {
      await configureJira({ settings: { projectKey: 'WEB' } });
      const other = await createWorkspace(app, {
        emailPrefix: 'globex-owner',
        slug: 'globex',
        projectKey: 'MOB',
      });

      const asOther = {
        token: other.owner.accessToken,
        organizationId: other.organizationId,
      };
      const list = await request('GET', '/api/v1/integrations', asOther);
      expect(list.json().every((provider: { id: string | null }) => provider.id === null)).toBe(
        true,
      );

      // The other organization can configure the same provider without
      // touching the first one: the row is per organization, not global.
      const created = await request('PUT', '/api/v1/integrations/jira', {
        ...asOther,
        payload: { mode: 'mock' },
      });
      expect(created.json().settings).toEqual({});

      const mine = (await request('GET', '/api/v1/integrations/jira', asOwner())).json();
      expect(mine.settings).toEqual({ projectKey: 'WEB' });
    });

    it('refuses a request without an active organization', async () => {
      const response = await request('GET', '/api/v1/integrations', {
        token: workspace.owner.accessToken,
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
