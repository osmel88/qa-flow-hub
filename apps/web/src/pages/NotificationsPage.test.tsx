import type { NotificationView, OrganizationRoleName } from '@qa-flow-hub/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';

/**
 * Owners and admins can force a failed delivery from the organization ledger;
 * everyone else only reads their own rows and never sees the action.
 */
const failed: NotificationView = {
  id: 'ntf_1',
  type: 'defect_assignment',
  category: 'defect_assignments',
  channel: 'email',
  subject: 'Defect assigned: Checkout is broken',
  recipientUserId: 'u_2',
  recipientEmail: 'tester@example.test',
  status: 'failed',
  provider: 'mock',
  attempts: 1,
  attemptedAt: '2026-10-04T10:00:00.000Z',
  deliveredAt: null,
  nextAttemptAt: '2026-10-04T10:01:00.000Z',
  failureReason: 'provider_unavailable',
  skipReason: null,
  createdAt: '2026-10-04T10:00:00.000Z',
  metadata: {},
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/retry') && init?.method === 'POST') {
      return json({ ...failed, status: 'sent', attempts: 2, nextAttemptAt: null });
    }
    if (url.includes('/notifications/provider')) {
      return json({ provider: 'mock', mode: 'mock', inspectable: false, fromAddress: 'qa@x' });
    }
    if (url.includes('/notifications')) {
      return json({ data: [failed], meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 } });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderAs(role: OrganizationRoleName): Promise<void> {
  vi.doMock('../auth/auth-context', () => ({
    useAuth: () => ({
      user: { id: 'u_1', email: 'me@example.test', fullName: 'Me', avatarUrl: null },
      activeOrganization: { id: 'org_1', name: 'Acme', slug: 'acme', role },
    }),
  }));
  const { NotificationsPage } = await import('./NotificationsPage');
  renderScreen(<NotificationsPage />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../auth/auth-context');
});

describe('NotificationsPage', () => {
  it('shows when a failed row is retried next', async () => {
    stubApi();
    await renderAs('tester');
    expect(await screen.findByText(/provider unavailable — retry/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('lets an owner retry a failed row from the organization ledger', async () => {
    const fetchMock = stubApi();
    await renderAs('organization_owner');
    await screen.findByText(failed.subject);
    expect(
      screen.queryByRole('button', { name: `Retry ${failed.subject}` }),
    ).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'organization');
    await userEvent.click(await screen.findByRole('button', { name: `Retry ${failed.subject}` }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/notifications/ntf_1/retry') && init?.method === 'POST',
        ),
      ).toBe(true);
    });
  });
});
