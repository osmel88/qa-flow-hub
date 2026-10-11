import { LIMITED_RESOURCES, PLAN_CATALOG } from '@qa-flow-hub/shared';
import type {
  BillingOverviewView,
  LimitedResource,
  OrganizationPlanName,
  PlanDescriptor,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { billingApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import {
  APPROACHING_RATIO,
  RESOURCE_LABELS,
  formatDate,
  formatMoney,
  formatUsage,
} from '../components/billing-format';
import { humanize } from '../components/status';

const planLabel = (plan: OrganizationPlanName): string => PLAN_CATALOG[plan].label;

const RANK: Record<OrganizationPlanName, number> = { free: 0, team: 1, business: 2 };

const STATUS_TONE: Record<string, BadgeTone> = {
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  canceled: 'neutral',
  incomplete: 'danger',
  paid: 'success',
  open: 'warning',
  draft: 'neutral',
  void: 'neutral',
  uncollectible: 'danger',
};

function UsageMeter({
  resource,
  used,
  limit,
}: {
  resource: LimitedResource;
  used: number;
  limit: number | null;
}): React.JSX.Element {
  const id = `usage-${resource}`;
  const ratio = limit === null || limit === 0 ? 0 : used / limit;
  const state =
    limit === null
      ? null
      : ratio > 1
        ? 'Over the limit'
        : ratio >= APPROACHING_RATIO
          ? 'Approaching the limit'
          : null;
  return (
    <div className="usage-meter" data-testid={id}>
      <div className="usage-meter__label">
        <span id={id}>{RESOURCE_LABELS[resource]}</span>
        <span>
          {formatUsage(resource, used)} /{' '}
          {limit === null ? 'Unlimited' : formatUsage(resource, limit)}
        </span>
      </div>
      {limit !== null && (
        <progress aria-labelledby={id} max={limit} value={Math.min(used, limit)} />
      )}
      {state !== null && <p className={ratio > 1 ? 'ui-field__error' : 'muted'}>{state}</p>}
    </div>
  );
}

function subscriptionSummary(view: BillingOverviewView): string {
  const sub = view.subscription;
  switch (view.reason) {
    case 'trial':
      return `Trial of ${planLabel(sub?.plan ?? 'team')} until ${formatDate(view.until)}.`;
    case 'trial_expired':
      return 'The trial has ended. You are on the Free plan.';
    case 'active':
      if (sub?.cancelAtPeriodEnd === true) {
        return `Cancels on ${formatDate(view.until)}; after that the Free plan applies.`;
      }
      if (sub?.pendingPlan != null) {
        return `Changes to ${planLabel(sub.pendingPlan)} on ${formatDate(view.until)}.`;
      }
      return `Renews on ${formatDate(view.until)}.`;
    case 'past_due_grace':
      return `The last payment failed. The plan stays active until ${formatDate(view.until)}.`;
    case 'past_due_expired':
      return 'The grace period after a failed payment has ended. You are on the Free plan.';
    case 'canceled':
      return 'The subscription was canceled. You are on the Free plan.';
    case 'incomplete':
      return 'The payment did not complete. You are on the Free plan.';
    case 'period_ended':
      return 'The billing period ended without a renewal. You are on the Free plan.';
    case 'no_subscription':
      return 'No subscription. You are on the Free plan.';
  }
}

function PlanCard({
  descriptor,
  view,
  canManage,
  busy,
  onChoose,
}: {
  descriptor: PlanDescriptor;
  view: BillingOverviewView;
  canManage: boolean;
  busy: boolean;
  onChoose: (plan: OrganizationPlanName) => void;
}): React.JSX.Element {
  const current = descriptor.plan === view.effectivePlan;
  const direction = RANK[descriptor.plan] > RANK[view.effectivePlan] ? 'Upgrade' : 'Downgrade';
  return (
    <section
      className={current ? 'card plan-card--current' : 'card'}
      aria-labelledby={`plan-${descriptor.plan}`}
    >
      <h3 id={`plan-${descriptor.plan}`}>
        {descriptor.label} {current && <Badge tone="info">Current</Badge>}
      </h3>
      <p>{formatMoney(descriptor.monthlyPriceCents, descriptor.currency)} / month</p>
      <ul>
        {LIMITED_RESOURCES.map((resource) => (
          <li key={resource}>
            {RESOURCE_LABELS[resource]}:{' '}
            {descriptor.limits[resource] === null
              ? 'Unlimited'
              : formatUsage(resource, descriptor.limits[resource])}
          </li>
        ))}
      </ul>
      {canManage && !current && (
        <Button
          variant={direction === 'Upgrade' ? 'primary' : 'secondary'}
          loading={busy}
          onClick={() => {
            onChoose(descriptor.plan);
          }}
        >
          {direction} to {descriptor.label}
        </Button>
      )}
    </section>
  );
}

export function BillingPage(): React.JSX.Element {
  const { activeOrganization } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const role = activeOrganization?.role;
  const canRead = role === 'organization_owner' || role === 'organization_admin';
  const canManage = role === 'organization_owner';
  const organizationId = activeOrganization?.id;

  const overview = useQuery({
    queryKey: ['billing', organizationId],
    queryFn: () => billingApi.overview(),
    enabled: canRead && organizationId !== undefined,
  });
  const invoices = useQuery({
    queryKey: ['billing-invoices', organizationId, page],
    queryFn: () => billingApi.invoices(page),
    enabled: canRead && organizationId !== undefined,
  });

  const refresh = async (): Promise<void> => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['billing', organizationId] });
    await queryClient.invalidateQueries({ queryKey: ['billing-invoices', organizationId] });
  };
  const onError = (cause: unknown): void => {
    setError(cause instanceof ApiError ? cause.message : 'The billing request failed.');
  };

  const choose = useMutation({
    mutationFn: async (plan: OrganizationPlanName) => {
      const sub = overview.data?.subscription;
      const paying =
        sub !== null &&
        sub !== undefined &&
        sub.status !== 'trialing' &&
        sub.status !== 'canceled' &&
        sub.status !== 'incomplete';
      if (!paying && plan !== 'free') {
        const session = await billingApi.checkout(plan);
        window.location.assign(new URL(session.url, window.location.origin).pathname);
        return;
      }
      if (plan === 'free') {
        await billingApi.cancel();
        return;
      }
      await billingApi.changePlan({ plan });
    },
    onSuccess: refresh,
    onError,
  });
  const cancel = useMutation({
    mutationFn: () => billingApi.cancel(),
    onSuccess: refresh,
    onError,
  });
  const resume = useMutation({
    mutationFn: () => billingApi.resume(),
    onSuccess: refresh,
    onError,
  });
  const endPeriod = useMutation({
    mutationFn: (outcome: 'succeeded' | 'failed') => billingApi.endMockPeriod(outcome),
    onSuccess: refresh,
    onError,
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="Billing" />
        <p className="muted" role="status">
          Only organization owners and admins can see billing.
        </p>
      </>
    );
  }

  const view = overview.data;
  const sub = view?.subscription ?? null;
  const live =
    sub !== null &&
    (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'trialing');

  return (
    <>
      <PageHeader
        title="Billing"
        description={
          canManage
            ? 'Plan, usage and invoices of this organization.'
            : 'Plan, usage and invoices of this organization. Only owners can change the plan.'
        }
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState isPending={overview.isPending} error={overview.error}>
        {view !== undefined && (
          <>
            <section className="card" aria-labelledby="subscription-heading">
              <h2 id="subscription-heading">
                {planLabel(view.effectivePlan)} plan{' '}
                {sub !== null && (
                  <Badge tone={STATUS_TONE[sub.status] ?? 'neutral'}>{humanize(sub.status)}</Badge>
                )}
              </h2>
              <p data-testid="billing-summary">{subscriptionSummary(view)}</p>
              {view.overLimit.length > 0 && (
                <p className="ui-field__error" role="status">
                  Usage is above this plan for{' '}
                  {view.overLimit.map((r) => RESOURCE_LABELS[r].toLowerCase()).join(', ')}. Nothing
                  is deleted or hidden; only new items are blocked.
                </p>
              )}
              {canManage && live && sub.cancelAtPeriodEnd !== true && sub.status !== 'trialing' && (
                <Button
                  variant="secondary"
                  loading={cancel.isPending}
                  onClick={() => {
                    cancel.mutate();
                  }}
                >
                  Cancel at period end
                </Button>
              )}
              {canManage && sub?.status === 'trialing' && (
                <Button
                  variant="secondary"
                  loading={cancel.isPending}
                  onClick={() => {
                    cancel.mutate();
                  }}
                >
                  End trial
                </Button>
              )}
              {canManage && sub?.cancelAtPeriodEnd === true && (
                <Button
                  loading={resume.isPending}
                  onClick={() => {
                    resume.mutate();
                  }}
                >
                  Keep subscription
                </Button>
              )}
              {canManage &&
                view.provider === 'mock' &&
                (sub?.status === 'active' || sub?.status === 'past_due') && (
                  <div className="callout">
                    <p className="muted">Mock provider: simulate the end of the billing period.</p>
                    <Button
                      variant="secondary"
                      loading={endPeriod.isPending}
                      onClick={() => {
                        endPeriod.mutate('succeeded');
                      }}
                    >
                      Renew (payment succeeds)
                    </Button>{' '}
                    <Button
                      variant="secondary"
                      loading={endPeriod.isPending}
                      onClick={() => {
                        endPeriod.mutate('failed');
                      }}
                    >
                      Renew (payment fails)
                    </Button>
                  </div>
                )}
            </section>

            <section className="card" aria-labelledby="usage-heading">
              <h2 id="usage-heading">Usage</h2>
              {LIMITED_RESOURCES.map((resource) => (
                <UsageMeter
                  key={resource}
                  resource={resource}
                  used={view.usage[resource]}
                  limit={view.limits[resource]}
                />
              ))}
            </section>

            <section aria-labelledby="plans-heading">
              <h2 id="plans-heading">Plans</h2>
              <div className="plan-grid">
                {view.plans.map((descriptor) => (
                  <PlanCard
                    key={descriptor.plan}
                    descriptor={descriptor}
                    view={view}
                    canManage={canManage}
                    busy={choose.isPending}
                    onChoose={(plan) => {
                      choose.mutate(plan);
                    }}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </DataState>

      <section className="card" aria-labelledby="invoices-heading">
        <h2 id="invoices-heading">Invoices</h2>
        <DataState
          isPending={invoices.isPending}
          error={invoices.error}
          isEmpty={(invoices.data?.data.length ?? 0) === 0}
          emptyMessage="No invoices yet."
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Issued</th>
                <th scope="col">Plan</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.data?.data.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{invoice.number}</td>
                  <td>{formatDate(invoice.issuedAt)}</td>
                  <td>{invoice.plan === null ? '—' : planLabel(invoice.plan)}</td>
                  <td>{formatMoney(invoice.amountDueCents, invoice.currency)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>
                      {humanize(invoice.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(invoices.data?.meta.totalPages ?? 1) > 1 && (
            <div className="row">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                }}
              >
                Previous
              </Button>
              <span className="muted">
                Page {page} of {invoices.data?.meta.totalPages}
              </span>
              <Button
                variant="secondary"
                disabled={page >= (invoices.data?.meta.totalPages ?? 1)}
                onClick={() => {
                  setPage(page + 1);
                }}
              >
                Next
              </Button>
            </div>
          )}
        </DataState>
      </section>
    </>
  );
}
