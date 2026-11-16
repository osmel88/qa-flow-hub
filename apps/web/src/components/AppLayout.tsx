import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { BillingBanner } from './BillingBanner';
import { MfaBanner } from './MfaBanner';
import { useProject } from '../project/project-context';
import { LanguageSelector, useI18n } from '../i18n/i18n';
import type { MessageKey } from '../i18n/messages/en';

const NAV: ReadonlyArray<{ to: string; label: MessageKey }> = [
  { to: '/dashboard', label: 'nav.dashboard' },
  { to: '/projects', label: 'nav.projects' },
  { to: '/requirements', label: 'nav.requirements' },
  { to: '/backlog', label: 'nav.backlog' },
  { to: '/hierarchy', label: 'nav.hierarchy' },
  { to: '/sprints', label: 'nav.sprints' },
  { to: '/board', label: 'nav.board' },
  { to: '/kanban', label: 'nav.kanban' },
  { to: '/development', label: 'nav.development' },
  { to: '/code-reviews', label: 'nav.codeReviews' },
  { to: '/builds', label: 'nav.builds' },
  { to: '/deployments', label: 'nav.deployments' },
  { to: '/environments', label: 'nav.environments' },
  { to: '/quality-gates', label: 'nav.qualityGates' },
  { to: '/approval-rules', label: 'nav.approvalRules' },
  { to: '/work-items', label: 'nav.workItems' },
  { to: '/test-cases', label: 'nav.testCases' },
  { to: '/imports', label: 'nav.imports' },
  { to: '/releases', label: 'nav.releases' },
  { to: '/test-plans', label: 'nav.testPlans' },
  { to: '/test-runs', label: 'nav.testRuns' },
  { to: '/exploratory-sessions', label: 'nav.exploratory' },
  { to: '/flaky-tests', label: 'nav.flakyTests' },
  { to: '/qa-metrics', label: 'nav.qaMetrics' },
  { to: '/defects', label: 'nav.defects' },
  { to: '/traceability', label: 'nav.traceability' },
  { to: '/customization', label: 'nav.customization' },
  { to: '/external-traceability', label: 'nav.externalReferences' },
  { to: '/members', label: 'nav.members' },
  { to: '/project-access', label: 'nav.projectAccess' },
  { to: '/api-keys', label: 'nav.apiKeys' },
  { to: '/settings/integrations', label: 'nav.integrations' },
  { to: '/billing', label: 'nav.billing' },
  { to: '/notifications', label: 'nav.notifications' },
  { to: '/profile', label: 'nav.profile' },
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
  const { t } = useI18n();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('common.skipToContent')}
      </a>

      <header className="shell__header">
        <div className="shell__brand">qa-flow-hub</div>

        <label className="shell__selector">
          <span className="shell__selector-label">{t('common.organization')}</span>
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
          <span className="shell__selector-label">{t('common.project')}</span>
          <select
            className="ui-input"
            value={activeProjectId ?? ''}
            disabled={projects.length === 0}
            onChange={(event) => {
              selectProject(event.target.value);
            }}
          >
            {projects.length === 0 && <option value="">{t('common.noProjectsYet')}</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key} — {project.name}
              </option>
            ))}
          </select>
        </label>

        <LanguageSelector className="shell__selector" labelClassName="shell__selector-label" />

        <div className="shell__user">
          <span className="muted">{user?.email}</span>
          <button
            className="ui-button ui-button--ghost ui-button--sm"
            onClick={() => void logout()}
          >
            {t('common.signOut')}
          </button>
        </div>
      </header>

      <div className="shell__body">
        <nav className="shell__nav" aria-label={t('common.mainNavigation')}>
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? 'nav-link nav-link--active' : 'nav-link'
                  }
                >
                  {t(item.label)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="shell__main" id="main">
          <MfaBanner />
          <BillingBanner />
          <Outlet key={activeOrganizationId ?? 'none'} />
        </main>
      </div>
    </div>
  );
}
