import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_CATALOG } from '@qa-flow-hub/shared';
import type { BillingOverviewView, OrganizationRoleName } from '@qa-flow-hub/shared';
import { renderScreen } from '../test/render';

const GB = 1024 ** 3;

const overview = (overrides: Partial<BillingOverviewView> = {}): BillingOverviewView => ({
  effectivePlan: 'team',
  reason: 'trial',
  until: '2026-10-25T00:00:00.000Z',
  subscription: {
    plan: 'team',
    status: 'trialing',
    provider: 'mock',
    trialEndsAt: '2026-10-25T00:00:00.000Z',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pendingPlan: null,
    pastDueSince: null,
    canceledAt: null,
  },
  limits: PLAN_CATALOG.team.limits,
  usage: { projects: 21, members: 3, storage: GB / 2 },
  overLimit: [],
  plans: Object.values(PLAN_CATALOG),
  provider: 'mock',
  ...overrides,
});

function renderAs(role: OrganizationRoleName, organizationId = 'org_1'): void {
  vi.doMock('../auth/auth-context', () => ({
    useAuth: () => ({
      user: { id: 'u_1', email: 'me@example.test', fullName: 'Me', avatarUrl: null },
      activeOrganization: { id: organizationId, name: 'Acme', slug: 'acme', role },
    }),
  }));
}

function stubApi(
  view: BillingOverviewView | (() => BillingOverviewView),
  invoices: Response | (() => Response) = () =>
    new Response(
      JSON.stringify({ data: [], meta: { total: 0, page: 1, pageSize: 10, totalPages: 0 } }),
    ),
): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes('/billing/invoices')) {
      return typeof invoices === 'function' ? invoices() : invoices;
    }
    return new Response(JSON.stringify(typeof view === 'function' ? view() : view), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../auth/auth-context');
});

describe('BillingPage', () => {
  it('shows an owner the trial, the meters and the plan controls', async () => {
    stubApi(overview());
    renderAs('organization_owner');
    const { BillingPage } = await import('./BillingPage');
    renderScreen(<BillingPage />);

    expect(await screen.findByTestId('billing-summary')).toHaveTextContent(/Trial of Team until/);
    expect(screen.getByTestId('usage-projects')).toHaveTextContent('21 / 25');
    expect(screen.getByTestId('usage-projects')).toHaveTextContent('Approaching the limit');
    expect(screen.getByTestId('usage-storage')).toHaveTextContent('512.0 MB / 50 GB');
    expect(screen.getByRole('button', { name: 'Upgrade to Business' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'End trial' })).toBeEnabled();
    expect(await screen.findByText('No invoices yet.')).toBeInTheDocument();
  });

  it('lets an admin read billing without any control to change it', async () => {
    stubApi(overview());
    renderAs('organization_admin');
    const { BillingPage } = await import('./BillingPage');
    renderScreen(<BillingPage />);

    expect(await screen.findByTestId('billing-summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade|Downgrade|End trial|Cancel/ })).toBeNull();
    expect(screen.getByText(/Only owners can change the plan/)).toBeInTheDocument();
  });

  it('does not even ask the API for other roles', async () => {
    const fetch = stubApi(overview());
    renderAs('qa_lead');
    const { BillingPage } = await import('./BillingPage');
    renderScreen(<BillingPage />);

    expect(screen.getByText(/Only organization owners and admins/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explains the grace period and usage above the plan, without hiding anything', async () => {
    stubApi(
      overview({
        effectivePlan: 'free',
        reason: 'past_due_expired',
        limits: PLAN_CATALOG.free.limits,
        usage: { projects: 5, members: 2, storage: 0 },
        overLimit: ['projects'],
      }),
    );
    renderAs('organization_owner');
    const { BillingPage } = await import('./BillingPage');
    renderScreen(<BillingPage />);

    expect(await screen.findByTestId('billing-summary')).toHaveTextContent(
      /grace period .* has ended/,
    );
    expect(screen.getByTestId('usage-projects')).toHaveTextContent('5 / 3');
    expect(screen.getByTestId('usage-projects')).toHaveTextContent('Over the limit');
    expect(screen.getByText(/Nothing is deleted or hidden/)).toBeInTheDocument();
  });

  it('lists invoices and reports an invoice failure on its own', async () => {
    stubApi(
      overview(),
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'INTERNAL_ERROR', message: 'Invoices are unavailable' },
          }),
          { status: 500 },
        ),
    );
    renderAs('organization_owner');
    const { BillingPage } = await import('./BillingPage');
    renderScreen(<BillingPage />);

    expect(await screen.findByText('Invoices are unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('billing-summary')).toBeInTheDocument();
  });

  it('never shows the previous organization’s billing after a tenant switch', async () => {
    let current = overview({ usage: { projects: 21, members: 3, storage: 0 } });
    stubApi(() => current);
    renderAs('organization_owner', 'org_a');
    const { BillingPage } = await import('./BillingPage');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BillingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('usage-projects')).toHaveTextContent('21 / 25');

    vi.resetModules();
    vi.doUnmock('../auth/auth-context');
    current = overview({ usage: { projects: 2, members: 1, storage: 0 } });
    renderAs('organization_owner', 'org_b');
    const { BillingPage: Next } = await import('./BillingPage');
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Next key="org_b" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByText('21 / 25')).toBeNull();
    expect(await screen.findByTestId('usage-projects')).toHaveTextContent('2 / 25');
    expect(client.getQueryData(['billing', 'org_a'])).toBeDefined();
    expect(client.getQueryData(['billing', 'org_b'])).toBeDefined();
  });
});

describe('PlanLimitAlert', () => {
  it('turns a 402 into an explanation with the way out, and ignores other errors', async () => {
    const { PlanLimitAlert } = await import('../components/PlanLimitAlert');
    const { ApiError } = await import('../api/http-client');
    renderScreen(
      <>
        <PlanLimitAlert
          error={
            new ApiError(402, 'PLAN_LIMIT_REACHED', 'The free plan allows 3 projects; 3 in use')
          }
        />
        <PlanLimitAlert error={new ApiError(403, 'FORBIDDEN', 'No')} />
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /3 projects; 3 in use\. Nothing existing was removed/,
    );
    expect(screen.getByRole('link', { name: 'See plans and usage' })).toHaveAttribute(
      'href',
      '/billing',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
