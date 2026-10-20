import { computeEffectivePermissions } from '@qa-flow-hub/shared';
import type { ApiKeyView, OrganizationRoleName } from '@qa-flow-hub/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';

/**
 * The token must appear exactly once, right after creation, and never in the
 * list; revoking must call the API; roles without `api_keys.manage` see no form.
 */
const TOKEN = `qfh_AbCdEfGhIjKl_${'s'.repeat(43)}`;

const activeKey: ApiKeyView = {
  id: 'key_1',
  projectId: 'proj_1',
  name: 'GitHub Actions',
  prefix: 'qfh_AbCdEfGhIjKl',
  scopes: ['results:ingest'],
  state: 'active',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdById: 'u_1',
  createdAt: '2026-10-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubApi(role: OrganizationRoleName): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/permissions/me')) {
      return json({
        projectId: 'proj_1',
        userId: 'u_1',
        organizationRole: role,
        projectRole: null,
        hasAccess: true,
        effectiveRole: role,
        overrides: [],
        permissions: computeEffectivePermissions(role, []),
      });
    }
    if (url.includes('/revoke')) {
      return json({ ...activeKey, state: 'revoked', revokedAt: '2026-10-02T00:00:00.000Z' });
    }
    if (url.includes('/api-keys') && init?.method === 'POST') {
      return json({ key: activeKey, token: TOKEN }, 201);
    }
    if (url.includes('/api-keys')) {
      return json([activeKey]);
    }
    if (url.includes('/ingestion-reports')) {
      return json([]);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../project/project-context');
});

async function renderPage(): Promise<void> {
  vi.doMock('../project/project-context', () => ({
    useProject: () => ({ activeProjectId: 'proj_1', activeProject: { id: 'proj_1', key: 'WEB' } }),
  }));
  const { ApiKeysPage } = await import('./ApiKeysPage');
  renderScreen(<ApiKeysPage />);
}

describe('ApiKeysPage', () => {
  it('shows the token once after creating a key, and only the prefix in the list', async () => {
    const fetchMock = stubApi('project_manager');
    await renderPage();
    expect(await screen.findByText('qfh_AbCdEfGhIjKl')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Key name'), 'CI');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByLabelText('New API key token')).toHaveValue(TOKEN);
    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api-keys') && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      name: 'CI',
      scopes: ['results:ingest'],
      expiresInDays: 90,
    });

    await userEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
  });

  it('revokes a key through the API', async () => {
    const fetchMock = stubApi('organization_owner');
    await renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke GitHub Actions' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api-keys/key_1/revoke')),
      ).toBe(true);
    });
  });

  it('tells a tester they cannot manage keys instead of showing the form', async () => {
    stubApi('tester');
    await renderPage();
    expect(
      await screen.findByText(/do not have permission to manage API keys/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Key name')).not.toBeInTheDocument();
  });
});
