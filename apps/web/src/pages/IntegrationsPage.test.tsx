import type { IntegrationConnectionView } from '@qa-flow-hub/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRoleName } from '@qa-flow-hub/shared';
import { renderScreen } from '../test/render';

function connection(
  overrides: Partial<IntegrationConnectionView> & Pick<IntegrationConnectionView, 'provider'>,
): IntegrationConnectionView {
  return {
    id: null,
    displayName: 'Jira',
    mode: 'mock',
    enabled: false,
    status: 'disconnected',
    baseUrl: null,
    settings: {},
    accountMetadata: {},
    hasCredential: false,
    lastSyncedAt: null,
    lastConnectionTestAt: null,
    lastError: null,
    availableModes: ['mock'],
    connectable: false,
    unavailableReason: null,
    updatedAt: null,
    ...overrides,
  };
}

const CONNECTIONS: IntegrationConnectionView[] = [
  connection({
    provider: 'jira',
    id: 'ic_jira',
    displayName: 'Jira',
    baseUrl: 'https://acme.atlassian.net',
    settings: { projectKey: 'WEB' },
    unavailableReason: 'The Jira mock provider is implemented in S2-F2.',
  }),
  connection({
    provider: 'testrail',
    displayName: 'TestRail',
    unavailableReason: 'The TestRail mock provider is implemented in S2-F3.',
  }),
  connection({
    provider: 'github',
    displayName: 'GitHub',
    mode: 'real',
    availableModes: ['real'],
    unavailableReason: 'GitHub connects for real in S2-F4, which delivers the credential store.',
  }),
];

function renderAs(role: OrganizationRoleName): void {
  vi.doMock('../auth/auth-context', () => ({
    useAuth: () => ({
      user: { id: 'u_1', email: 'me@example.test', fullName: 'Me', avatarUrl: null },
      activeOrganization: { id: 'org_1', name: 'Acme', slug: 'acme', role },
    }),
  }));
}

function stubApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).includes('/test-connection')) {
      return new Response(
        JSON.stringify({
          provider: 'jira',
          reachable: false,
          message: 'The Jira mock provider is implemented in S2-F2.',
          checkedAt: '2026-08-31T10:00:00.000Z',
          connection: CONNECTIONS[0],
        }),
        { status: 200 },
      );
    }
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify(CONNECTIONS[0]), { status: 200 });
    }
    return new Response(JSON.stringify(CONNECTIONS), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../auth/auth-context');
});

describe('IntegrationsPage', () => {
  it('shows the three providers with the phase that unblocks each one', async () => {
    stubApi();
    renderAs('organization_owner');
    const { IntegrationsPage: Page } = await import('./IntegrationsPage');

    renderScreen(<Page />);

    expect(await screen.findByRole('heading', { name: 'Jira' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'TestRail' })).toBeInTheDocument();
    const github = screen.getByRole('heading', { name: 'GitHub' }).closest('section');
    expect(github).not.toBeNull();
    expect(within(github as HTMLElement).getByText(/S2-F4/)).toBeInTheDocument();
  });

  it('offers no editing to a role that cannot manage integrations', async () => {
    stubApi();
    renderAs('tester');
    const { IntegrationsPage: Page } = await import('./IntegrationsPage');

    renderScreen(<Page />);

    expect(await screen.findByRole('heading', { name: 'Jira' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only organization owners and admins/)).toBeInTheDocument();
  });

  it('reports the provider answer of a connection test', async () => {
    stubApi();
    renderAs('organization_owner');
    const { IntegrationsPage: Page } = await import('./IntegrationsPage');

    renderScreen(<Page />);
    const jira = (await screen.findByRole('heading', { name: 'Jira' })).closest(
      'section',
    ) as HTMLElement;

    await userEvent.click(within(jira).getByRole('button', { name: 'Test connection' }));

    expect(await within(jira).findByRole('status')).toHaveTextContent('S2-F2');
  });

  it('refuses to send a configuration that is not key=value', async () => {
    const fetchMock = stubApi();
    renderAs('organization_owner');
    const { IntegrationsPage: Page } = await import('./IntegrationsPage');

    renderScreen(<Page />);
    const jira = (await screen.findByRole('heading', { name: 'Jira' })).closest(
      'section',
    ) as HTMLElement;
    const configuration = within(jira).getByLabelText('Configuration');
    await userEvent.clear(configuration);
    await userEvent.type(configuration, 'projectKey');
    await userEvent.click(within(jira).getByRole('button', { name: 'Save' }));

    expect(await within(jira).findByRole('alert')).toHaveTextContent('key=value');
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(false);
  });

  it('never renders a credential, only whether one is stored', async () => {
    stubApi();
    renderAs('organization_owner');
    const { IntegrationsPage: Page } = await import('./IntegrationsPage');

    renderScreen(<Page />);
    const jira = (await screen.findByRole('heading', { name: 'Jira' })).closest(
      'section',
    ) as HTMLElement;

    expect(within(jira).getByText('None')).toBeInTheDocument();
    expect(jira.textContent).not.toContain('secretRef');
  });
});
