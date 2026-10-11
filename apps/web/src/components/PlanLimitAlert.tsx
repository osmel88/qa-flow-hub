import { Link } from 'react-router-dom';
import { ApiError } from '../api/http-client';

/**
 * The 402 a plan limit produces, with the way out. Renders nothing for any
 * other error, so a screen can place it next to its usual error line.
 */
export function PlanLimitAlert({ error }: { error: unknown }): React.JSX.Element | null {
  if (!(error instanceof ApiError) || error.code !== 'PLAN_LIMIT_REACHED') {
    return null;
  }
  return (
    <p className="callout" role="alert">
      {error.message}. Nothing existing was removed. <Link to="/billing">See plans and usage</Link>
    </p>
  );
}
