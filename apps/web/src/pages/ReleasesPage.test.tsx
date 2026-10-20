import { computeEffectivePermissions } from '@qa-flow-hub/shared';
import type { OrganizationRoleName, ReleaseView } from '@qa-flow-hub/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';

/**
 * Releases are listed for every role; only `releases.manage` sees the form,
 * and the form sends exactly what the API contract expects.
 */
const release: ReleaseView = {
  id: 'rel_1',
  projectId: 'proj_1',
  name: 'Spring launch',
  version: '2.4.0',
  tag: 'v2.4.0',
  description: null,
  status: 'in_progress',
  startDate: null,
  targetDate: '2026-10-31',
  releasedAt: null,
  archivedAt: null,
  createdById: 'u_1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  runCount: 3,
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
    if (url.includes('/releases') && init?.method === 'POST') {
      return json({ ...release, id: 'rel_2', version: '2.5.0' }, 201);
    }
    if (url.includes('/releases')) {
      return json({ data: [release], meta: { page: 1, pageSize: 100, total: 1, totalPages: 1 } });
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
  const { ReleasesPage } = await import('./ReleasesPage');
  renderScreen(<ReleasesPage />);
}

describe('ReleasesPage', () => {
  it('lists releases and creates one with the contract payload', async () => {
    const fetchMock = stubApi('project_manager');
    await renderPage();
    expect(await screen.findByRole('link', { name: 'Spring launch' })).toHaveAttribute(
      'href',
      '/releases/rel_1',
    );

    await userEvent.type(await screen.findByLabelText('Release name'), 'Summer');
    await userEvent.type(screen.getByLabelText('Version'), '2.5.0');
    await userEvent.click(screen.getByRole('button', { name: 'Create release' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).endsWith('/releases') && init?.method === 'POST',
        ),
      ).toBe(true);
    });
    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/releases') && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      projectId: 'proj_1',
      name: 'Summer',
      version: '2.5.0',
      tag: null,
      startDate: null,
      targetDate: null,
    });
  });

  it('shows a tester the releases but not the form', async () => {
    stubApi('tester');
    await renderPage();
    expect(await screen.findByRole('link', { name: 'Spring launch' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Release name')).not.toBeInTheDocument();
  });
});
