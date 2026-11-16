import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { mfaApi } from '../api/endpoints';
import { useAuth } from '../auth/auth-context';
import { t } from '../i18n/i18n';

/**
 * Explains the 403s a member gets when the active organization requires MFA
 * and this session did not pass it, and points at the one way out.
 */
export function MfaBanner(): React.JSX.Element | null {
  const { activeOrganization } = useAuth();
  const required = activeOrganization?.requireMfa === true;
  const status = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => mfaApi.status(),
    enabled: required,
  });
  if (!required || status.data === undefined || status.data.sessionVerified) {
    return null;
  }
  return (
    <aside
      className="billing-banner billing-banner--danger"
      aria-label={t('c_mfaBanner.securityNotice')}
      data-testid="mfa-banner"
    >
      {status.data.enabled
        ? t('c_mfaBanner.requiresMultiFactorAuthenticationSign', { name: activeOrganization.name })
        : t('c_mfaBanner.requiresMultiFactorAuthentication', {
            name: activeOrganization.name,
          })}{' '}
      <Link to="/profile">{t('c_mfaBanner.setUpMfaInYour')}</Link>
    </aside>
  );
}
