import { Link } from 'react-router-dom';

/**
 * Shown instead of an empty table when no project is selected. A screen that
 * silently renders zero rows reads as a broken feature; this says what to do.
 */
export function NoProject(): React.JSX.Element {
  return (
    <div className="ui-state ui-state--empty">
      <p>This screen works inside a project, and there is none selected yet.</p>
      <Link className="ui-button ui-button--primary ui-button--sm" to="/projects">
        Create a project
      </Link>
    </div>
  );
}
