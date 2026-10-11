import { PLAN_CATALOG } from '@qa-flow-hub/shared';
import { Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { billingApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { formatMoney } from '../components/billing-format';

/**
 * Stands in for the provider's hosted checkout while the mock provider is
 * selected. Paying here only asks the mock to emit its signed webhooks; the
 * plan changes when those webhooks are verified and applied, as it would
 * with a real provider.
 */
export function MockCheckoutPage(): React.JSX.Element {
  const { sessionId = '' } = useParams();
  const { activeOrganization } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const session = useQuery({
    queryKey: ['billing-checkout', activeOrganization?.id, sessionId],
    queryFn: () => billingApi.mockSession(sessionId),
    enabled: activeOrganization !== undefined && sessionId !== '',
  });

  const complete = useMutation({
    mutationFn: (outcome: 'succeeded' | 'failed') =>
      billingApi.completeMockCheckout(sessionId, { outcome }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
      await queryClient.invalidateQueries({ queryKey: ['billing-invoices'] });
      void navigate('/billing');
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'The payment could not be simulated.');
    },
  });

  return (
    <>
      <PageHeader
        title="Checkout (mock provider)"
        description="No card is charged. Choose the simulated outcome."
      />
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <DataState isPending={session.isPending} error={session.error}>
        {session.data !== undefined && (
          <section className="card" aria-labelledby="checkout-heading">
            <h2 id="checkout-heading">
              {PLAN_CATALOG[session.data.plan].label} —{' '}
              {formatMoney(session.data.amountCents, session.data.currency)} / month
            </h2>
            {session.data.status === 'open' ? (
              <>
                <Button
                  loading={complete.isPending}
                  onClick={() => {
                    complete.mutate('succeeded');
                  }}
                >
                  Pay
                </Button>{' '}
                <Button
                  variant="secondary"
                  loading={complete.isPending}
                  onClick={() => {
                    complete.mutate('failed');
                  }}
                >
                  Simulate a declined card
                </Button>
              </>
            ) : (
              <p className="muted">This checkout is {session.data.status}.</p>
            )}
          </section>
        )}
      </DataState>
    </>
  );
}
