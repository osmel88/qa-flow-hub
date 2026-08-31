import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRoleName } from '@qa-flow-hub/shared';
import { renderScreen } from '../test/render';

/**
 * The page is imported inside each test on purpose: the mocked auth context has
 * to be in place before the module reads it.
 */

const members = {
  data: [
    {
      userId: 'u_owner',
      email: 'owner@example.test',
      fullName: 'Grace Hopper',
      avatarUrl: null,
      role: 'organization_owner',
      status: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      userId: 'u_tester',
      email: 'tester@example.test',
      fullName: 'Alan Turing',
      avatarUrl: null,
      role: 'tester',
      status: 'active',
      joinedAt: '2026-01-02T00:00:00.000Z',
    },
  ],
  meta: { total: 2, page: 1, pageSize: 20 },
};

/** Renders the page as somebody holding `role` in the active organization. */
function renderAs(role: OrganizationRoleName, userId: string): void {
  vi.doMock('../auth/auth-context', () => ({
    useAuth: () => ({
      user: { id: userId, email: 'me@example.test', fullName: 'Me', avatarUrl: null },
      activeOrganization: { id: 'org_1', name: 'Acme', slug: 'acme', role },
    }),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../auth/auth-context');
});

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) =>
      String(input).includes('/invitations')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify(members), { status: 200 }),
    ),
  );
}

describe('MembersPage', () => {
  it('lets an admin change a tester but not an owner, and says why', async () => {
    stubApi();
    renderAs('organization_admin', 'u_admin');
    const { MembersPage: Page } = await import('./MembersPage');

    renderScreen(<Page />);

    const ownerSelect = await screen.findByLabelText('Change role of owner@example.test');
    expect(ownerSelect).toBeDisabled();
    // The API refuses this with a 403; the screen has to say so instead of
    // offering the action and surfacing the error afterwards.
    expect(screen.getByText(/cannot change a member who is organization owner/i)).toBeInTheDocument();

    expect(screen.getByLabelText('Change role of tester@example.test')).toBeEnabled();
  });

  it('never offers a role more powerful than the actor holds', async () => {
    stubApi();
    renderAs('organization_admin', 'u_admin');
    const { MembersPage: Page } = await import('./MembersPage');

    renderScreen(<Page />);

    const select = await screen.findByLabelText('Change role of tester@example.test');
    const options = within(select).getAllByRole('option').map((option) => option.textContent);
    expect(options).not.toContain('organization owner');
    expect(options).toContain('organization admin');
  });

  it('disables the row of the current user, because changing your own role is refused', async () => {
    stubApi();
    renderAs('organization_owner', 'u_owner');
    const { MembersPage: Page } = await import('./MembersPage');

    renderScreen(<Page />);

    expect(await screen.findByLabelText('Change role of owner@example.test')).toBeDisabled();
    expect(screen.getByText(/cannot change your own role/i)).toBeInTheDocument();
  });
});
