import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { billingApi } from '../api/endpoints';
import { useAuth } from '../auth/auth-context';
import { formatDate } from './billing-format';
import { t } from '../i18n/i18n';

/**
 * One line above every screen when billing needs attention: a trial or a
 * grace period running out, or usage above the plan. Only owners and admins
 * can read billing, so only they get the banner (and the request).
 */
export function BillingBanner(): React.JSX.Element | null {
  const { activeOrganization } = useAuth();
  const role = activeOrganization?.role;
  const canRead = role === 'organization_owner' || role === 'organization_admin';

  const overview = useQuery({
    queryKey: ['billing', activeOrganization?.id],
    queryFn: () => billingApi.overview(),
    enabled: canRead && activeOrganization !== undefined,
  });

  const data = overview.data;
  if (!canRead || data === undefined) {
    return null;
  }

  let message: string | null = null;
  let danger = false;
  if (data.reason === 'trial') {
    message = t('c_billingBanner.teamTrialEnds', { date: formatDate(data.until) });
  } else if (data.reason === 'past_due_grace') {
    message = t('c_billingBanner.paymentFailed', { date: formatDate(data.until) });
    danger = true;
  } else if (data.overLimit.length > 0) {
    message = t('c_billingBanner.overLimit', {
      plan: data.effectivePlan,
      resources: data.overLimit.join(', '),
    });
    danger = true;
  }
  if (message === null) {
    return null;
  }

  return (
    <aside
      className={danger ? 'billing-banner billing-banner--danger' : 'billing-banner'}
      aria-label={t('c_billingBanner.billingNotice')}
      data-testid="billing-banner"
    >
      {message} <Link to="/billing">{t('c_billingBanner.billing')}</Link>
    </aside>
  );
}
