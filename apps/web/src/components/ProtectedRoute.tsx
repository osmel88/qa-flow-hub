import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';

/**
 * A gate for the router, not for security. The API rejects every request on
 * its own; this only avoids rendering screens that would fail. Treating a
 * client-side guard as protection is how tenant data leaks.
 */
export function ProtectedRoute(): React.JSX.Element {
  const { user, isRestoring, organizations } = useAuth();
  const location = useLocation();

  if (isRestoring) {
    return (
      <p className="ui-state" role="status">
        Restoring your session…
      </p>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (organizations.length === 0 && location.pathname !== '/organizations') {
    return <Navigate to="/organizations" replace />;
  }

  return <Outlet />;
}
