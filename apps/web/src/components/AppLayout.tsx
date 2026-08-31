import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { useProject } from '../project/project-context';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/projects', label: 'Projects' },
  { to: '/requirements', label: 'Requirements' },
  { to: '/test-cases', label: 'Test cases' },
  { to: '/test-runs', label: 'Test runs' },
  { to: '/defects', label: 'Defects' },
  { to: '/traceability', label: 'Traceability' },
  { to: '/members', label: 'Members' },
  { to: '/project-access', label: 'Project access' },
  { to: '/profile', label: 'Profile' },
];

/**
 * The shell: organization on the left of the header, project next to it, and
 * the navigation below. Both selectors are always visible because the single
 * most dangerous mistake in a multi-tenant tool is editing the right screen in
 * the wrong tenant.
 */
export function AppLayout(): React.JSX.Element {
  const { user, organizations, activeOrganizationId, selectOrganization, logout } = useAuth();
  const { projects, activeProjectId, selectProject } = useProject();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="shell__header">
        <div className="shell__brand">qa-flow-hub</div>

        <label className="shell__selector">
          <span className="shell__selector-label">Organization</span>
          <select
            className="ui-input"
            value={activeOrganizationId ?? ''}
            onChange={(event) => {
              selectOrganization(event.target.value);
            }}
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>

        <label className="shell__selector">
          <span className="shell__selector-label">Project</span>
          <select
            className="ui-input"
            value={activeProjectId ?? ''}
            disabled={projects.length === 0}
            onChange={(event) => {
              selectProject(event.target.value);
            }}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key} — {project.name}
              </option>
            ))}
          </select>
        </label>

        <div className="shell__user">
          <span className="muted">{user?.email}</span>
          <button className="ui-button ui-button--ghost ui-button--sm" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="shell__body">
        <nav className="shell__nav" aria-label="Main">
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="shell__main" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
