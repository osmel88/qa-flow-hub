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

const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
] as const;

type View = 'project' | 'organization';

const DAY_MS = 24 * 60 * 60 * 1000;

function deltaText(comparison: PeriodComparison, unit: string): string {
  if (comparison.delta === null) {
    return 'No previous window to compare';
  }
  const sign = comparison.delta > 0 ? '+' : '';
  return `${sign}${comparison.delta}${unit} vs previous window`;
}

function periodText(period: { from: string; to: string; bucket: string }): string {
  return `${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}, by ${period.bucket}`;
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
        <h2 id="kpi-heading">Key indicators</h2>
        <DataState isPending={summary.isPending} error={summary.error}>
          {summary.data !== undefined && (
            <>
              <p className="muted small">
                {periodText(summary.data.period)} · computed{' '}
                {new Date(summary.data.computedAt).toLocaleString()}
              </p>
              <div className="metrics">
                <Kpi
                  label="Pass rate"
                  value={formatPercent(summary.data.execution.passRate)}
                  detail={deltaText(summary.data.comparison.passRate, ' pts')}
                />
                <Kpi label="Failed rate" value={formatPercent(summary.data.execution.failedRate)} />
                <Kpi
                  label="Blocked rate"
                  value={formatPercent(summary.data.execution.blockedRate)}
                />
                <Kpi
                  label="Skipped / untested"
                  value={`${formatPercent(summary.data.execution.skippedRate)} / ${formatPercent(summary.data.execution.untestedRate)}`}
                />
                <Kpi
                  label="Execution progress"
                  value={formatPercent(summary.data.execution.progress)}
                />
                <Kpi
                  label="Executed vs pending"
                  value={`${summary.data.execution.executed} / ${summary.data.execution.pending}`}
                  detail={`${summary.data.execution.planned} planned`}
                />
                <Kpi
                  label="Coverage"
                  value={formatPercent(summary.data.coverage.percentage)}
                  detail={`${summary.data.coverage.covered} of ${summary.data.coverage.requirements} requirements`}
                />
                <Kpi
                  label="Uncovered requirements"
                  value={String(summary.data.coverage.uncovered)}
                />
                <Kpi
                  label="Open defects"
                  value={String(summary.data.defects.open)}
                  detail={`${summary.data.defects.openCritical} blocker or critical`}
                />
                <Kpi
                  label="Defects per executed case"
                  value={formatNumber(summary.data.defects.perExecutedCase)}
                  detail={deltaText(summary.data.comparison.defectsCreated, ' created')}
                />
                <Kpi
                  label="Mean time to resolve"
                  value={
                    summary.data.meanTimeToResolve.hours === null
                      ? '—'
                      : `${summary.data.meanTimeToResolve.hours} h`
                  }
                  detail={`${summary.data.meanTimeToResolve.sampleSize} resolved in window`}
                />
              </div>
            </>
          )}
        </DataState>
      </section>

      <section className="dashboard-section" aria-labelledby="trends-heading">
        <h2 id="trends-heading">Trends</h2>
        <DataState isPending={trends.isPending} error={trends.error}>
          {trends.data !== undefined && (
            <div className="grid-2">
              <TrendChart
                title="Pass rate and coverage"
                points={trends.data.points}
                series={[
                  { key: 'passRate', label: 'Pass rate', unit: 'percent' },
                  { key: 'coverage', label: 'Coverage', unit: 'percent' },
                ]}
              />
              <TrendChart
                title="Defects over time"
                points={trends.data.points}
                series={[
                  { key: 'defectsOpen', label: 'Open', unit: 'count' },
                  { key: 'defectsCreated', label: 'Created', unit: 'count' },
                  { key: 'defectsClosed', label: 'Closed', unit: 'count' },
                ]}
              />
            </div>
          )}
        </DataState>
      </section>

      <section className="dashboard-section" aria-labelledby="execution-heading">
        <h2 id="execution-heading">Execution</h2>
        <DataState isPending={results.isPending} error={results.error}>
          {results.data !== undefined && (
            <>
              <div className="grid-2">
                <ExecutionDistribution
                  title="Result distribution"
                  execution={results.data.execution}
                />
                <BarList
                  title="Pass rate by milestone"
                  rows={results.data.milestones.map((row) => ({
                    key: row.milestone ?? '__none__',
                    label: row.milestone ?? 'No milestone',
                    value: row.execution.passRate ?? 0,
                    display: `${formatPercent(row.execution.passRate)} · ${row.runs} runs`,
                  }))}
                  max={100}
                  empty="No run in this window."
                />
              </div>
              <section className="card" aria-labelledby="runs-heading">
                <h3 id="runs-heading">Runs in this window</h3>
                {results.data.runs.length === 0 ? (
                  <p className="muted">No run in this window.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Run</th>
                          <th scope="col">Milestone</th>
                          <th scope="col">Status</th>
                          <th scope="col">Progress</th>
                          <th scope="col">Pass rate</th>
                          <th scope="col">Defects</th>
                          <th scope="col">Per executed case</th>
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
        <h2 id="coverage-heading">Coverage</h2>
        <DataState isPending={coverage.isPending} error={coverage.error}>
          {coverage.data !== undefined && (
            <div className="grid-2">
              <BarList
                title="Coverage by requirement priority"
                rows={coverage.data.byPriority.map((row) => ({
                  key: row.priority,
                  label: humanize(row.priority),
                  value: row.percentage ?? 0,
                  display: `${formatPercent(row.percentage)} (${row.covered}/${row.requirements})`,
                }))}
                max={100}
              />
              <section className="card" aria-labelledby="uncovered-heading">
                <h3 id="uncovered-heading">Requirements without coverage</h3>
                {coverage.data.uncoveredRequirements.length === 0 ? (
                  <p className="muted">Every active requirement is linked to a test case.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="table table--compact">
                      <thead>
                        <tr>
                          <th scope="col">Key</th>
                          <th scope="col">Title</th>
                          <th scope="col">Priority</th>
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
        <h2 id="defects-heading">Defects</h2>
        <DataState isPending={defects.isPending} error={defects.error}>
          {defects.data !== undefined && (
            <div className="grid-2">
              <BarList
                title="Open defects by severity"
                rows={DEFECT_SEVERITIES.map((severity) => ({
                  key: severity,
                  label: <Badge tone={toneFor(severity)}>{humanize(severity)}</Badge>,
                  value: defects.data.bySeverity[severity],
                }))}
              />
              <BarList
                title="Open defects by priority"
                rows={PRIORITIES.map((priority) => ({
                  key: priority,
                  label: humanize(priority),
                  value: defects.data.byPriority[priority],
                }))}
              />
              <BarList
                title="Open vs closed"
                rows={[
                  { key: 'open', label: 'Open', value: defects.data.open },
                  { key: 'closed', label: 'Closed or rejected', value: defects.data.closed },
                  {
                    key: 'created',
                    label: 'Created in window',
                    value: defects.data.createdInPeriod,
                  },
                  {
                    key: 'closed-window',
                    label: 'Closed in window',
                    value: defects.data.closedInPeriod,
                  },
                ]}
              />
              <BarList
                title="Defects by status"
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
            <h2 id="health-heading">Overall QA health</h2>
            <p className="muted small">
              {periodText(data.period)} · computed {new Date(data.computedAt).toLocaleString()}
            </p>
            <div className="metrics">
              <Kpi label="Projects" value={String(data.health.projects)} />
              <Kpi label="Pass rate" value={formatPercent(data.health.execution.passRate)} />
              <Kpi
                label="Execution progress"
                value={formatPercent(data.health.execution.progress)}
                detail={`${data.health.execution.executed} of ${data.health.execution.planned} cases`}
              />
              <Kpi
                label="Coverage"
                value={formatPercent(data.health.coverage.percentage)}
                detail={`${data.health.coverage.uncovered} uncovered requirements`}
              />
              <Kpi label="Open defects" value={String(data.health.openDefects)} />
              <Kpi label="Open critical defects" value={String(data.health.openCritical)} />
            </div>
          </section>

          <section className="dashboard-section" aria-labelledby="rankings-heading">
            <h2 id="rankings-heading">Projects needing attention</h2>
            <div className="grid-2">
              <BarList
                title="Most failures"
                rows={data.mostFailures.map((row) => ({
                  key: row.projectId,
                  label: `${row.key} — ${row.name}`,
                  value: row.value,
                  display: `${row.value} failed`,
                }))}
                empty="No failed case in this window."
              />
              <BarList
                title="Least coverage"
                rows={data.leastCoverage.map((row) => ({
                  key: row.projectId,
                  label: `${row.key} — ${row.name}`,
                  value: row.value,
                  display: `${row.value}%`,
                }))}
                max={100}
                empty="No project has requirements yet."
              />
            </div>
            <section className="card" aria-labelledby="projects-heading">
              <h3 id="projects-heading">Projects</h3>
              {data.projects.length === 0 ? (
                <p className="muted">No project you can analyse.</p>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col">Pass rate</th>
                        <th scope="col">Progress</th>
                        <th scope="col">Coverage</th>
                        <th scope="col">Open defects</th>
                        <th scope="col">Critical</th>
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
            <h2 id="global-trends-heading">Global trends</h2>
            <div className="grid-2">
              <TrendChart
                title="Pass rate and coverage across projects"
                points={data.trends}
                series={[
                  { key: 'passRate', label: 'Pass rate', unit: 'percent' },
                  { key: 'coverage', label: 'Coverage', unit: 'percent' },
                ]}
              />
              <TrendChart
                title="Defects across projects"
                points={data.trends}
                series={[
                  { key: 'defectsOpen', label: 'Open', unit: 'count' },
                  { key: 'defectsCreated', label: 'Created', unit: 'count' },
                  { key: 'defectsClosed', label: 'Closed', unit: 'count' },
                ]}
              />
            </div>
          </section>

          <section className="card" aria-labelledby="activity-heading">
            <h2 id="activity-heading">Recent activity</h2>
            {data.recentActivity.length === 0 ? (
              <p className="muted">Nothing happened in this window.</p>
            ) : (
              <ul className="activity-list">
                {data.recentActivity.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <time dateTime={item.at} className="muted small">
                      {new Date(item.at).toLocaleString()}
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
        title="Dashboard"
        description={
          view === 'organization' || activeProject === null
            ? 'Quality across every project you can analyse in this organization.'
            : `Quality of ${activeProject.key} — ${activeProject.name}.`
        }
      />

      <div className="card dashboard-toolbar">
        <div className="segmented" role="group" aria-label="Dashboard scope">
          <button
            type="button"
            aria-pressed={view === 'project'}
            disabled={activeProjectId === null}
            onClick={() => {
              setView('project');
            }}
          >
            Project
          </button>
          <button
            type="button"
            aria-pressed={view === 'organization'}
            onClick={() => {
              setView('organization');
            }}
          >
            Organization
          </button>
        </div>
        <label className="ui-field">
          <span className="ui-field__label">Window</span>
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
