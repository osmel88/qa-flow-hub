import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { mfaApi } from '../api/endpoints';
import { useAuth } from '../auth/auth-context';

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
      aria-label="Security notice"
      data-testid="mfa-banner"
    >
      {status.data.enabled
        ? `${activeOrganization.name} requires multi-factor authentication. Sign out and sign in again with your authenticator.`
        : `${activeOrganization.name} requires multi-factor authentication.`}{' '}
      <Link to="/profile">Set up MFA in your profile</Link>
    </aside>
  );
}
