import {
  DEFECT_SEVERITIES,
  DEFECT_STATUSES,
  PRIORITIES,
  type PeriodComparison,
} from '@qa-flow-hub/shared';
import { Badge, DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type AnalyticsWindow, analyticsApi } from '../api/endpoints';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import {
  BarList,
  ExecutionDistribution,
  Kpi,
  TrendChart,
  formatNumber,
  formatPercent,
} from '../components/analytics/charts';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

const WINDOWS = [
  {
    days: 7,
    get label() {
      return t('dashboard.last7Days');
    },
  },
  {
    days: 30,
    get label() {
      return t('dashboard.last30Days');
    },
  },
  {
    days: 90,
    get label() {
      return t('dashboard.last90Days');
    },
  },
  {
    days: 365,
    get label() {
      return t('dashboard.last12Months');
    },
  },
] as const;

type View = 'project' | 'organization';

const DAY_MS = 24 * 60 * 60 * 1000;

function deltaText(comparison: PeriodComparison, unit: string): string {
  if (comparison.delta === null) {
    return t('dashboard.noPreviousWindowToCompare');
  }
  const sign = comparison.delta > 0 ? '+' : '';
  return t('dashboard.vsPreviousWindow', { sign, delta: comparison.delta, unit });
}

function periodText(period: { from: string; to: string; bucket: string }): string {
  return t('dashboard.by', {
    value: period.from.slice(0, 10),
    value2: period.to.slice(0, 10),
    bucket: period.bucket,
  });
}

function ProjectAnalytics({
  projectId,
  window,
}: {
  projectId: string;
  window: AnalyticsWindow;
}): React.JSX.Element {
  const { activeOrganizationId } = useAuth();
  const key = ['analytics', activeOrganizationId, projectId, window] as const;
  const summary = useQuery({
    queryKey: [...key, 'summary'],
    queryFn: () => analyticsApi.summary(projectId, window),
  });
  const results = useQuery({
    queryKey: [...key, 'test-results'],
    queryFn: () => analyticsApi.testResults(projectId, window),
  });
  const coverage = useQuery({
    queryKey: [...key, 'coverage'],
    queryFn: () => analyticsApi.coverage(projectId, window),
  });
  const defects = useQuery({
    queryKey: [...key, 'defects'],
    queryFn: () => analyticsApi.defects(projectId, window),
  });
  const trends = useQuery({
    queryKey: [...key, 'trends'],
    queryFn: () => analyticsApi.trends(projectId, window),
  });

  return (
    <>
      <section className="dashboard-section" aria-labelledby="kpi-heading">
        <h2 id="kpi-heading">{t('dashboard.keyIndicators')}</h2>
        <DataState isPending={summary.isPending} error={summary.error}>
          {summary.data !== undefined && (
            <>
              <p className="muted small">
                {periodText(summary.data.period)} {t('dashboard.computed')}{' '}
                {formatDateTime(summary.data.computedAt)}
              </p>
              <div className="metrics">
                <Kpi
                  label={t('dashboard.passRate')}
                  value={formatPercent(summary.data.execution.passRate)}
                  detail={deltaText(summary.data.comparison.passRate, ' pts')}
                />
                <Kpi
                  label={t('dashboard.failedRate')}
                  value={formatPercent(summary.data.execution.failedRate)}
                />
                <Kpi
                  label={t('dashboard.blockedRate')}
                  value={formatPercent(summary.data.execution.blockedRate)}
                />
                <Kpi
                  label={t('dashboard.skippedUntested')}
                  value={`${formatPercent(summary.data.execution.skippedRate)} / ${formatPercent(summary.data.execution.untestedRate)}`}
                />
                <Kpi
                  label={t('dashboard.executionProgress')}
                  value={formatPercent(summary.data.execution.progress)}
                />
                <Kpi
                  label={t('dashboard.executedVsPending')}
                  value={`${summary.data.execution.executed} / ${summary.data.execution.pending}`}
                  detail={`${summary.data.execution.planned} planned`}
                />
                <Kpi
                  label={t('dashboard.coverage')}
                  value={formatPercent(summary.data.coverage.percentage)}
                  detail={t('dashboard.coveredOfRequirements', {
                    covered: summary.data.coverage.covered,
                    requirements: summary.data.coverage.requirements,
                  })}
                />
                <Kpi
                  label={t('dashboard.uncoveredRequirements')}
                  value={String(summary.data.coverage.uncovered)}
                />
                <Kpi
                  label={t('dashboard.openDefects')}
                  value={String(summary.data.defects.open)}
                  detail={t('dashboard.blockerOrCritical', {
                    count: summary.data.defects.openCritical,
                  })}
                />
                <Kpi
                  label={t('dashboard.defectsPerExecutedCase')}
                  value={formatNumber(summary.data.defects.perExecutedCase)}
                  detail={deltaText(
                    summary.data.comparison.defectsCreated,
                    t('dashboard.createdUnit'),
                  )}
                />
                <Kpi
                  label={t('dashboard.meanTimeToResolve')}
                  value={
                    summary.data.meanTimeToResolve.hours === null
                      ? '—'
                      : `${summary.data.meanTimeToResolve.hours} h`
                  }
                  detail={t('dashboard.resolvedInWindow', {
                    count: summary.data.meanTimeToResolve.sampleSize,
                  })}
                />
              </div>
            </>
          )}
        </DataState>
      </section>

      <section className="dashboard-section" aria-labelledby="trends-heading">
        <h2 id="trends-heading">{t('dashboard.trends')}</h2>
        <DataState isPending={trends.isPending} error={trends.error}>
          {trends.data !== undefined && (
            <div className="grid-2">
              <TrendChart
                title={t('dashboard.passRateAndCoverage')}
                points={trends.data.points}
                series={[
                  { key: 'passRate', label: t('dashboard.passRate'), unit: 'percent' },
                  { key: 'coverage', label: t('dashboard.coverage'), unit: 'percent' },
                ]}
              />
              <TrendChart
                title={t('dashboard.defectsOverTime')}
                points={trends.data.points}
                series={[
                  { key: 'defectsOpen', label: t('dashboard.open'), unit: 'count' },
                  { key: 'defectsCreated', label: t('dashboard.created'), unit: 'count' },
                  { key: 'defectsClosed', label: t('dashboard.closed'), unit: 'count' },
                ]}
              />
            </div>
          )}
        </DataState>
      </section>

      <section className="dashboard-section" aria-labelledby="execution-heading">
        <h2 id="execution-heading">{t('dashboard.execution')}</h2>
        <DataState isPending={results.isPending} error={results.error}>
          {results.data !== undefined && (
            <>
              <div className="grid-2">
                <ExecutionDistribution
                  title={t('dashboard.resultDistribution')}
                  execution={results.data.execution}
                />
                <BarList
                  title={t('dashboard.passRateByMilestone')}
                  rows={results.data.milestones.map((row) => ({
                    key: row.milestone ?? '__none__',
                    label: row.milestone ?? t('dashboard.noMilestone'),
                    value: row.execution.passRate ?? 0,
                    display: t('dashboard.passRateRuns', {
                      rate: formatPercent(row.execution.passRate),
                      runs: row.runs,
                    }),
                  }))}
                  max={100}
                  empty={t('dashboard.noRunInThisWindow')}
                />
              </div>
              <section className="card" aria-labelledby="runs-heading">
                <h3 id="runs-heading">{t('dashboard.runsInThisWindow')}</h3>
                {results.data.runs.length === 0 ? (
                  <p className="muted">{t('dashboard.noRunInThisWindow')}</p>
                ) : (
                  <div className="table-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">{t('dashboard.run')}</th>
                          <th scope="col">{t('dashboard.milestone')}</th>
                          <th scope="col">{t('dashboard.status')}</th>
                          <th scope="col">{t('dashboard.progress')}</th>
                          <th scope="col">{t('dashboard.passRate')}</th>
                          <th scope="col">{t('dashboard.defects')}</th>
                          <th scope="col">{t('dashboard.perExecutedCase')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.data.runs.map((run) => (
                          <tr key={run.id}>
                            <td>{run.name}</td>
                            <td>{run.milestone ?? '—'}</td>
                            <td>
                              <Badge tone={toneFor(run.status)}>{humanize(run.status)}</Badge>
                            </td>
                            <td>
                              <progress max={100} value={run.execution.progress ?? 0} />{' '}
                              {formatPercent(run.execution.progress)}
                            </td>
                            <td>{formatPercent(run.execution.passRate)}</td>
                            <td>{run.defects}</td>
                            <td>{formatNumber(run.defectsPerExecutedCase)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </DataState>
      </section>

      <section className="dashboard-section" aria-labelledby="coverage-heading">
        <h2 id="coverage-heading">{t('dashboard.coverage')}</h2>
        <DataState isPending={coverage.isPending} error={coverage.error}>
          {coverage.data !== undefined && (
            <div className="grid-2">
              <BarList
                title={t('dashboard.coverageByRequirementPriority')}
                rows={coverage.data.byPriority.map((row) => ({
                  key: row.priority,
                  label: humanize(row.priority),
                  value: row.percentage ?? 0,
                  display: `${formatPercent(row.percentage)} (${row.covered}/${row.requirements})`,
                }))}
                max={100}
              />
              <section className="card" aria-labelledby="uncovered-heading">
                <h3 id="uncovered-heading">{t('dashboard.requirementsWithoutCoverage')}</h3>
                {coverage.data.uncoveredRequirements.length === 0 ? (
                  <p className="muted">{t('dashboard.everyActiveRequirementIsLinked')}</p>
                ) : (
                  <div className="table-scroll">
                    <table className="table table--compact">
                      <thead>
                        <tr>
                          <th scope="col">{t('dashboard.key')}</th>
                          <th scope="col">{t('dashboard.title')}</th>
                          <th scope="col">{t('dashboard.priority')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {coverage.data.uncoveredRequirements.map((row) => (
                          <tr key={row.id}>
                            <td>{row.key}</td>
                            <td>{row.title}</td>
                            <td>
                              <Badge tone={toneFor(row.priority)}>{humanize(row.priority)}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}
        </DataState>
      </section>

      <section className="dashboard-section" aria-labelledby="defects-heading">
        <h2 id="defects-heading">{t('dashboard.defects')}</h2>
        <DataState isPending={defects.isPending} error={defects.error}>
          {defects.data !== undefined && (
            <div className="grid-2">
              <BarList
                title={t('dashboard.openDefectsBySeverity')}
                rows={DEFECT_SEVERITIES.map((severity) => ({
                  key: severity,
                  label: <Badge tone={toneFor(severity)}>{humanize(severity)}</Badge>,
                  value: defects.data.bySeverity[severity],
                }))}
              />
              <BarList
                title={t('dashboard.openDefectsByPriority')}
                rows={PRIORITIES.map((priority) => ({
                  key: priority,
                  label: humanize(priority),
                  value: defects.data.byPriority[priority],
                }))}
              />
              <BarList
                title={t('dashboard.openVsClosed')}
                rows={[
                  { key: 'open', label: t('dashboard.open'), value: defects.data.open },
                  {
                    key: 'closed',
                    label: t('dashboard.closedOrRejected'),
                    value: defects.data.closed,
                  },
                  {
                    key: 'created',
                    label: t('dashboard.createdInWindow'),
                    value: defects.data.createdInPeriod,
                  },
                  {
                    key: 'closed-window',
                    label: t('dashboard.closedInWindow'),
                    value: defects.data.closedInPeriod,
                  },
                ]}
              />
              <BarList
                title={t('dashboard.defectsByStatus')}
                rows={DEFECT_STATUSES.map((status) => ({
                  key: status,
                  label: humanize(status),
                  value: defects.data.byStatus[status],
                }))}
              />
            </div>
          )}
        </DataState>
      </section>
    </>
  );
}

function OrganizationAnalytics({ window }: { window: AnalyticsWindow }): React.JSX.Element {
  const { activeOrganizationId, isRestoring } = useAuth();
  const { data, isPending, error } = useQuery({
    queryKey: ['analytics', activeOrganizationId, 'organization', window],
    queryFn: () => analyticsApi.organization(window),
    enabled: !isRestoring && activeOrganizationId !== null,
  });

  return (
    <DataState isPending={isPending} error={error}>
      {data !== undefined && (
        <>
          <section className="dashboard-section" aria-labelledby="health-heading">
            <h2 id="health-heading">{t('dashboard.overallQaHealth')}</h2>
            <p className="muted small">
              {periodText(data.period)} {t('dashboard.computed')} {formatDateTime(data.computedAt)}
            </p>
            <div className="metrics">
              <Kpi label={t('dashboard.projects')} value={String(data.health.projects)} />
              <Kpi
                label={t('dashboard.passRate')}
                value={formatPercent(data.health.execution.passRate)}
              />
              <Kpi
                label={t('dashboard.executionProgress')}
                value={formatPercent(data.health.execution.progress)}
                detail={t('dashboard.executedOfCases', {
                  executed: data.health.execution.executed,
                  planned: data.health.execution.planned,
                })}
              />
              <Kpi
                label={t('dashboard.coverage')}
                value={formatPercent(data.health.coverage.percentage)}
                detail={t('dashboard.uncoveredCount', { count: data.health.coverage.uncovered })}
              />
              <Kpi label={t('dashboard.openDefects')} value={String(data.health.openDefects)} />
              <Kpi
                label={t('dashboard.openCriticalDefects')}
                value={String(data.health.openCritical)}
              />
            </div>
          </section>

          <section className="dashboard-section" aria-labelledby="rankings-heading">
            <h2 id="rankings-heading">{t('dashboard.projectsNeedingAttention')}</h2>
            <div className="grid-2">
              <BarList
                title={t('dashboard.mostFailures')}
                rows={data.mostFailures.map((row) => ({
                  key: row.projectId,
                  label: `${row.key} — ${row.name}`,
                  value: row.value,
                  display: t('dashboard.failedCount', { count: row.value }),
                }))}
                empty={t('dashboard.noFailedCaseInThisWindow')}
              />
              <BarList
                title={t('dashboard.leastCoverage')}
                rows={data.leastCoverage.map((row) => ({
                  key: row.projectId,
                  label: `${row.key} — ${row.name}`,
                  value: row.value,
                  display: `${row.value}%`,
                }))}
                max={100}
                empty={t('dashboard.noProjectHasRequirementsYet')}
              />
            </div>
            <section className="card" aria-labelledby="projects-heading">
              <h3 id="projects-heading">{t('dashboard.projects')}</h3>
              {data.projects.length === 0 ? (
                <p className="muted">{t('dashboard.noProjectYouCanAnalyse')}</p>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">{t('dashboard.project')}</th>
                        <th scope="col">{t('dashboard.passRate')}</th>
                        <th scope="col">{t('dashboard.progress')}</th>
                        <th scope="col">{t('dashboard.coverage')}</th>
                        <th scope="col">{t('dashboard.openDefects')}</th>
                        <th scope="col">{t('dashboard.critical')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projects.map((row) => (
                        <tr key={row.projectId}>
                          <td>
                            {row.key} — {row.name}
                          </td>
                          <td>{formatPercent(row.execution.passRate)}</td>
                          <td>{formatPercent(row.execution.progress)}</td>
                          <td>{formatPercent(row.coverage.percentage)}</td>
                          <td>{row.openDefects}</td>
                          <td>{row.openCritical}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </section>

          <section className="dashboard-section" aria-labelledby="global-trends-heading">
            <h2 id="global-trends-heading">{t('dashboard.globalTrends')}</h2>
            <div className="grid-2">
              <TrendChart
                title={t('dashboard.passRateAndCoverageAcross')}
                points={data.trends}
                series={[
                  { key: 'passRate', label: t('dashboard.passRate'), unit: 'percent' },
                  { key: 'coverage', label: t('dashboard.coverage'), unit: 'percent' },
                ]}
              />
              <TrendChart
                title={t('dashboard.defectsAcrossProjects')}
                points={data.trends}
                series={[
                  { key: 'defectsOpen', label: t('dashboard.open'), unit: 'count' },
                  { key: 'defectsCreated', label: t('dashboard.created'), unit: 'count' },
                  { key: 'defectsClosed', label: t('dashboard.closed'), unit: 'count' },
                ]}
              />
            </div>
          </section>

          <section className="card" aria-labelledby="activity-heading">
            <h2 id="activity-heading">{t('dashboard.recentActivity')}</h2>
            {data.recentActivity.length === 0 ? (
              <p className="muted">{t('dashboard.nothingHappenedInThisWindow')}</p>
            ) : (
              <ul className="activity-list">
                {data.recentActivity.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <time dateTime={item.at} className="muted small">
                      {formatDateTime(item.at)}
                    </time>
                    <span>
                      {item.projectKey} · {humanize(item.kind)}
                    </span>
                    <span>{item.label}</span>
                    <Badge tone={toneFor(item.status)}>{humanize(item.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </DataState>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { activeProject, activeProjectId } = useProject();
  const [days, setDays] = useState<number>(30);
  const [chosenView, setView] = useState<View>('project');
  const view: View = activeProjectId === null ? 'organization' : chosenView;
  const window = useMemo<AnalyticsWindow>(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - days * DAY_MS).toISOString(), to: to.toISOString() };
  }, [days]);

  return (
    <>
      <PageHeader
        title={t('dashboard.dashboard')}
        description={
          view === 'organization' || activeProject === null
            ? t('dashboard.qualityAcrossEveryProjectYou')
            : t('dashboard.qualityOf', { key: activeProject.key, name: activeProject.name })
        }
      />

      <div className="card dashboard-toolbar">
        <div className="segmented" role="group" aria-label={t('dashboard.dashboardScope')}>
          <button
            type="button"
            aria-pressed={view === 'project'}
            disabled={activeProjectId === null}
            onClick={() => {
              setView('project');
            }}
          >
            {t('dashboard.project')}
          </button>
          <button
            type="button"
            aria-pressed={view === 'organization'}
            onClick={() => {
              setView('organization');
            }}
          >
            {t('dashboard.organization')}
          </button>
        </div>
        <label className="ui-field">
          <span className="ui-field__label">{t('dashboard.window')}</span>
          <select
            className="ui-input"
            value={days}
            onChange={(event) => {
              setDays(Number(event.target.value));
            }}
          >
            {WINDOWS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {view === 'project' && activeProjectId !== null ? (
        <ProjectAnalytics projectId={activeProjectId} window={window} />
      ) : (
        <OrganizationAnalytics window={window} />
      )}
    </>
  );
}
