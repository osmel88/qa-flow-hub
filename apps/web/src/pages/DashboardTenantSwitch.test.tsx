import { coverageKpis, emptyExecutionCounts, executionKpis } from '@qa-flow-hub/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/auth-context';
import { DashboardPage } from './DashboardPage';

vi.mock('../project/project-context', () => ({
  useProject: () => ({
    projects: [],
    activeProject: null,
    activeProjectId: null,
    selectProject: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

const organizations = [
  { id: 'org_a', name: 'Acme', slug: 'acme', role: 'organization_owner' },
  { id: 'org_b', name: 'Globex', slug: 'globex', role: 'organization_owner' },
];

const dashboardFor = (projects: number) => ({
  period: { from: '2026-09-04T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', bucket: 'day' },
  computedAt: '2026-10-04T10:00:00.000Z',
  health: {
    projects,
    execution: executionKpis(emptyExecutionCounts()),
    coverage: coverageKpis(0, 0),
    openDefects: 0,
    openCritical: 0,
  },
  projects: [],
  mostFailures: [],
  leastCoverage: [],
  trends: [],
  recentActivity: [],
});

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function Switcher(): React.JSX.Element {
  const { activeOrganizationId, selectOrganization, logout } = useAuth();
  return (
    <>
      <span data-testid="tenant">{activeOrganizationId ?? 'none'}</span>
      <button type="button" onClick={() => selectOrganization('org_b')}>
        Switch to Globex
      </button>
      <button type="button" onClick={() => void logout()}>
        Log out
      </button>
    </>
  );
}

describe('switching tenant on the organization dashboard', () => {
  let releaseGlobex: () => void;
  let client: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    const globexReady = new Promise<void>((resolve) => {
      releaseGlobex = resolve;
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const tenant = (init?.headers as Record<string, string> | undefined)?.['X-Organization-Id'];
      if (url.endsWith('/auth/refresh')) {
        return json({ accessToken: 'token', refreshToken: null, expiresIn: 900 });
      }
      if (url.endsWith('/auth/me')) {
        return json({ id: 'usr_1', email: 'ana@example.test', fullName: 'Ana', organizations });
      }
      if (url.endsWith('/auth/logout')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/dashboard/organization')) {
        if (tenant === 'org_a') {
          return json(dashboardFor(7));
        }
        if (tenant === 'org_b') {
          await globexReady;
          return json(dashboardFor(3));
        }
        return json({ error: { code: 'FORBIDDEN', message: 'No tenant' } }, 403);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'Nope' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderDashboard = () =>
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <Switcher />
            <DashboardPage />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  const dashboardTenants = () =>
    fetchMock.mock.calls
      .filter(([input]) => String(input).includes('/dashboard/organization'))
      .map(([, init]) => (init?.headers as Record<string, string>)['X-Organization-Id']);

  it('never shows the previous tenant totals and asks with the new tenant', async () => {
    const user = userEvent.setup();
    renderDashboard();

    const health = await screen.findByRole('region', { name: 'Overall QA health' });
    expect(health).toHaveTextContent('7Projects');

    await user.click(screen.getByRole('button', { name: 'Switch to Globex' }));

    expect(screen.getByTestId('tenant')).toHaveTextContent('org_b');
    // Globex has not answered yet: the screen must wait, not reuse Acme's totals.
    expect(screen.queryByText('7')).not.toBeInTheDocument();
    expect(client.getQueryCache().findAll({ queryKey: ['analytics', 'org_a'] })).toEqual([]);

    releaseGlobex();
    expect(await screen.findByRole('region', { name: 'Overall QA health' })).toHaveTextContent(
      '3Projects',
    );
    // Nothing was asked before the session was restored, nor without a tenant.
    expect(dashboardTenants()).toEqual(['org_a', 'org_b']);
  });

  it('drops every cached response on logout', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByRole('region', { name: 'Overall QA health' });
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => {
      expect(screen.getByTestId('tenant')).toHaveTextContent('none');
    });
    // The dashboard is still mounted here (no route guard in this test), so its
    // disabled query may exist again — but empty and keyed to no tenant.
    const remaining = client.getQueryCache().getAll();
    expect(remaining.every((query) => query.state.data === undefined)).toBe(true);
    expect(remaining.some((query) => query.queryKey.includes('org_a'))).toBe(false);
    expect(screen.queryByText('7')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });
});
