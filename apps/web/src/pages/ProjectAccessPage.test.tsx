import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRoleName } from '@qa-flow-hub/shared';
import { renderScreen } from '../test/render';

/**
 * What this screen must not do is show the organization role and call it
 * permission — that is the bug per-project roles exist to fix. So the tests are
 * about the three columns staying distinguishable, and about the controls being
 * derived from the actor's role *in this project*.
 */

const projectMembers = {
  data: [
    {
      userId: 'u_owner',
      email: 'owner@example.test',
      fullName: 'Grace Hopper',
      avatarUrl: null,
      organizationRole: 'organization_owner',
      projectRole: null,
      effectiveRole: 'organization_owner',
      grantedAt: null,
    },
    {
      userId: 'u_tester',
      email: 'tester@example.test',
      fullName: 'Alan Turing',
      avatarUrl: null,
      organizationRole: 'tester',
      projectRole: 'qa_lead',
      effectiveRole: 'qa_lead',
      grantedAt: '2026-02-01T00:00:00.000Z',
    },
    {
      userId: 'u_manager',
      email: 'manager@example.test',
      fullName: 'Barbara Liskov',
      avatarUrl: null,
      organizationRole: 'project_manager',
      projectRole: 'viewer',
      effectiveRole: 'viewer',
      grantedAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  meta: { total: 3, page: 1, pageSize: 100 },
};

function renderAs(role: OrganizationRoleName, userId: string): void {
  vi.doMock('../auth/auth-context', () => ({
    useAuth: () => ({
      user: { id: userId, email: 'me@example.test', fullName: 'Me', avatarUrl: null },
      activeOrganization: { id: 'org_1', name: 'Acme', slug: 'acme', role },
    }),
  }));
  vi.doMock('../project/project-context', () => ({
    useProject: () => ({
      activeProjectId: 'p_1',
      activeProject: { id: 'p_1', key: 'WEB', name: 'Web' },
      projects: [],
    }),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../auth/auth-context');
  vi.doUnmock('../project/project-context');
});

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(projectMembers), { status: 200 }))),
  );
}

describe('ProjectAccessPage', () => {
  it('shows the organization role, the project role and what is enforced', async () => {
    stubApi();
    renderAs('organization_owner', 'u_owner');
    const { ProjectAccessPage: Page } = await import('./ProjectAccessPage');

    renderScreen(<Page />);

    const row = (await screen.findByText('Alan Turing')).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement).getAllByRole('cell');
    expect(cells[1]?.textContent).toBe('tester');
    expect(cells[2]?.textContent).toBe('qa lead');
    expect(cells[3]?.textContent).toBe('qa lead');
  });

  it('marks a member with no grant as inheriting the organization role', async () => {
    stubApi();
    renderAs('organization_owner', 'u_owner');
    const { ProjectAccessPage: Page } = await import('./ProjectAccessPage');

    renderScreen(<Page />);

    const row = (await screen.findByText('Grace Hopper')).closest('tr');
    expect(within(row as HTMLElement).getByText('Inherited')).toBeInTheDocument();
  });

  it('refuses to offer changes to an owner or to yourself, and says why', async () => {
    stubApi();
    renderAs('organization_admin', 'u_admin');
    const { ProjectAccessPage: Page } = await import('./ProjectAccessPage');

    renderScreen(<Page />);

    expect(await screen.findByLabelText('Set the project role of owner@example.test')).toBeDisabled();
    expect(screen.getByText(/keeps full access to every project/i)).toBeInTheDocument();
  });

  it('hides the controls from a project manager narrowed to viewer here', async () => {
    stubApi();
    // Their organization role would allow managing access; their effective role
    // in this project is viewer, and the API is what decides.
    renderAs('project_manager', 'u_manager');
    const { ProjectAccessPage: Page } = await import('./ProjectAccessPage');

    renderScreen(<Page />);

    await screen.findByText('Alan Turing');
    expect(
      screen.queryByLabelText('Set the project role of tester@example.test'),
    ).not.toBeInTheDocument();
  });
});
