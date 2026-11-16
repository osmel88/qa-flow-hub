import {
  DEFECT_SEVERITIES,
  FLAKY_STATUSES,
  QA_METRICS_MIN_EXECUTED_FOR_DENSITY,
  QA_METRICS_MIN_VERDICTS,
} from '@qa-flow-hub/shared';
import type { QaMetricsProgressRow, QaMetricsView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  environmentsApi,
  qaMetricsApi,
  releasesApi,
  testCyclesApi,
  testPlansApi,
} from '../api/endpoints';
import { PageHeader } from '../components/PageHeader';
import { BarList, Kpi, formatPercent } from '../components/analytics/charts';
import { humanize } from '../components/status';
import { t } from '../i18n/i18n';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { FLAKY_TONE } from './FlakyTestsPage';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a date input to the window bounds: `to` is inclusive of its day. */
function windowParams(from: string, to: string): { from?: string; to?: string } {
  return {
    ...(from === '' ? {} : { from: new Date(`${from}T00:00:00.000Z`).toISOString() }),
    ...(to === ''
      ? {}
      : { to: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS).toISOString() }),
  };
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** QA metrics dashboard (S7-F7): one project's QA data, filtered and computed on read. */
export function QaMetricsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const projectId = activeProjectId ?? '';
  const enabled = activeProjectId !== null;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [testPlanId, setTestPlanId] = useState('');
  const [testCycleId, setTestCycleId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const invalidPeriod = from !== '' && to !== '' && from > to;
  const params = {
    ...windowParams(from, to),
    ...(testPlanId === '' ? {} : { testPlanId }),
    ...(testCycleId === '' ? {} : { testCycleId }),
    ...(releaseId === '' ? {} : { releaseId }),
    ...(environmentId === '' ? {} : { environmentId }),
  };
  const metrics = useQuery({
    queryKey: ['qa-metrics', activeProjectId, params],
    queryFn: () => qaMetricsApi.get(projectId, params),
    enabled: enabled && !invalidPeriod,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const plans = useQuery({
    queryKey: ['test-plans', activeProjectId, 'qa-metrics'],
    queryFn: () => testPlansApi.list({ projectId }),
    enabled,
  });
  const cycles = useQuery({
    queryKey: ['test-cycles', testPlanId],
    queryFn: () => testCyclesApi.list(testPlanId),
    enabled: enabled && testPlanId !== '',
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, 'qa-metrics'],
    queryFn: () => releasesApi.list({ projectId }),
    enabled,
  });
  const environments = useQuery({
    queryKey: ['environments', activeProjectId, 'qa-metrics'],
    queryFn: () => environmentsApi.list({ projectId }),
    enabled,
  });
  if (activeProjectId === null) {
    return <NoProject />;
  }
  const all = { value: '', label: t('qaMetrics.all') };
  const clear = () => {
    setFrom('');
    setTo('');
    setTestPlanId('');
    setTestCycleId('');
    setReleaseId('');
    setEnvironmentId('');
  };
  return (
    <>
      <PageHeader title={t('qaMetrics.title')} description={t('qaMetrics.description')} />
      <section className="card" aria-labelledby="qa-metrics-filters">
        <h2 id="qa-metrics-filters">{t('qaMetrics.filters')}</h2>
        <div className="filters">
          <TextField
            label={t('qaMetrics.from')}
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
          <TextField
            label={t('qaMetrics.to')}
            type="date"
            value={to}
            error={invalidPeriod ? t('qaMetrics.invalidPeriod') : undefined}
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
          <SelectField
            label={t('qaMetrics.testPlan')}
            value={testPlanId}
            options={[
              all,
              ...(plans.data?.data ?? []).map((plan) => ({ value: plan.id, label: plan.name })),
            ]}
            onChange={(event) => {
              setTestPlanId(event.target.value);
              setTestCycleId('');
            }}
          />
          <SelectField
            label={t('qaMetrics.testCycle')}
            value={testCycleId}
            disabled={testPlanId === ''}
            options={[
              all,
              ...(cycles.data?.data ?? []).map((cycle) => ({ value: cycle.id, label: cycle.name })),
            ]}
            onChange={(event) => {
              setTestCycleId(event.target.value);
            }}
          />
          <SelectField
            label={t('qaMetrics.release')}
            value={releaseId}
            options={[
              all,
              ...(releases.data?.data ?? []).map((release) => ({
                value: release.id,
                label: release.name,
              })),
            ]}
            onChange={(event) => {
              setReleaseId(event.target.value);
            }}
          />
          <SelectField
            label={t('qaMetrics.environment')}
            value={environmentId}
            options={[
              all,
              ...(environments.data ?? []).map((environment) => ({
                value: environment.id,
                label: environment.name,
              })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
        </div>
        <Button variant="secondary" onClick={clear}>
          {t('qaMetrics.clearFilters')}
        </Button>
      </section>
      {!invalidPeriod && (
        <DataState isPending={metrics.isPending} error={metrics.error}>
          {metrics.data !== undefined && <Metrics view={metrics.data} />}
        </DataState>
      )}
    </>
  );
}

function Metrics({ view }: { view: QaMetricsView }): React.JSX.Element {
  const { execution, rates, defects, flaky, exploratory } = view;
  const rateDetail = rates.insufficientData
    ? t('qaMetrics.notEnoughVerdicts', { min: QA_METRICS_MIN_VERDICTS })
    : t('qaMetrics.verdicts', { count: execution.verdicts });
  const rate = (value: number | null) =>
    rates.insufficientData ? t('qaMetrics.notEnoughData') : formatPercent(value);
  const hasTrend = view.trend.some((point) => point.passed + point.failed + point.blocked > 0);
  const flakyTracked = FLAKY_STATUSES.some((status) => flaky.counts[status] > 0);
  return (
    <>
      <p className="muted">
        {t('qaMetrics.period', { from: day(view.period.from), to: day(view.period.to) })}
      </p>
      <section className="card" aria-label={t('qaMetrics.executionCoverage')}>
        <div className="metrics">
          <Kpi label={t('qaMetrics.runsInScope')} value={String(view.runs)} />
          <Kpi
            label={t('qaMetrics.executionCoverage')}
            value={formatPercent(execution.progress)}
            detail={t('qaMetrics.executedOfPlanned', {
              executed: execution.executed,
              planned: execution.planned,
            })}
          />
          <Kpi label={t('qaMetrics.executed')} value={String(execution.executed)} />
          <Kpi label={t('qaMetrics.pending')} value={String(execution.pending)} />
          <Kpi label={t('qaMetrics.passRate')} value={rate(rates.passRate)} detail={rateDetail} />
          <Kpi label={t('qaMetrics.failRate')} value={rate(rates.failedRate)} />
          <Kpi label={t('qaMetrics.blockedRate')} value={rate(rates.blockedRate)} />
        </div>
      </section>

      <section className="card" aria-labelledby="qa-metrics-trend">
        <h2 id="qa-metrics-trend">{t('qaMetrics.resultsOverTime')}</h2>
        {hasTrend ? (
          <div className="table-scroll">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">{t('qaMetrics.bucket')}</th>
                  <th scope="col">{t('qaMetrics.passed')}</th>
                  <th scope="col">{t('qaMetrics.failed')}</th>
                  <th scope="col">{t('qaMetrics.blocked')}</th>
                  <th scope="col">{t('qaMetrics.passRate')}</th>
                </tr>
              </thead>
              <tbody>
                {view.trend.map((point) => (
                  <tr key={point.bucketStart}>
                    <td>{day(point.bucketStart)}</td>
                    <td>{point.passed}</td>
                    <td>{point.failed}</td>
                    <td>{point.blocked}</td>
                    <td>{formatPercent(point.passRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{t('qaMetrics.noResultsInPeriod')}</p>
        )}
      </section>

      <div className="grid-2">
        <ProgressTable
          id="qa-metrics-plans"
          title={t('qaMetrics.planProgress')}
          empty={t('qaMetrics.noPlans')}
          rows={view.plans}
          href={(row) => `/test-plans/${row.id}`}
        />
        <ProgressTable
          id="qa-metrics-cycles"
          title={t('qaMetrics.cycleProgress')}
          empty={t('qaMetrics.noCycles')}
          rows={view.cycles}
          href={(row) => `/test-cycles/${row.id}`}
        />
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="qa-metrics-defects">
          <h2 id="qa-metrics-defects">{t('qaMetrics.openDefects')}</h2>
          <div className="metrics">
            <Kpi label={t('qaMetrics.openDefects')} value={String(defects.open)} />
            <Kpi label={t('qaMetrics.defectsRaised')} value={String(defects.raisedInPeriod)} />
            <Kpi
              label={t('qaMetrics.defectDensity')}
              value={
                defects.density === null ? t('qaMetrics.notEnoughData') : String(defects.density)
              }
              detail={
                defects.density === null
                  ? t('qaMetrics.densityNeedsData', { min: QA_METRICS_MIN_EXECUTED_FOR_DENSITY })
                  : t('qaMetrics.defectDensityDetail')
              }
            />
          </div>
        </section>
        <BarList
          title={t('qaMetrics.openDefectsBySeverity')}
          rows={
            defects.open === 0
              ? []
              : DEFECT_SEVERITIES.map((severity) => ({
                  key: severity,
                  label: humanize(severity),
                  value: defects.openBySeverity[severity],
                }))
          }
        />
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="qa-metrics-flaky">
          <h2 id="qa-metrics-flaky">{t('qaMetrics.flakyTests')}</h2>
          {flakyTracked ? (
            <ul className="plain-list">
              {FLAKY_STATUSES.map((status) => (
                <li key={status}>
                  <Badge tone={FLAKY_TONE[status]}>{humanize(status)}</Badge>{' '}
                  <Link to="/flaky-tests">{flaky.counts[status]}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('qaMetrics.noFlakyData')}</p>
          )}
          <p className="muted">{t('qaMetrics.flakyScopeNote')}</p>
        </section>
        <section className="card" aria-labelledby="qa-metrics-flaky-evolution">
          <h2 id="qa-metrics-flaky-evolution">{t('qaMetrics.flakyEvolution')}</h2>
          <div className="table-scroll">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">{t('qaMetrics.bucket')}</th>
                  <th scope="col">{t('qaMetrics.flaky')}</th>
                  <th scope="col">{t('qaMetrics.suspect')}</th>
                  <th scope="col">{t('qaMetrics.failing')}</th>
                </tr>
              </thead>
              <tbody>
                {flaky.evolution.map((point) => (
                  <tr key={point.bucketStart}>
                    <td>{day(point.bucketEnd)}</td>
                    <td>{point.flaky}</td>
                    <td>{point.suspect}</td>
                    <td>{point.failing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="qa-metrics-exploratory">
          <h2 id="qa-metrics-exploratory">{t('qaMetrics.exploratory')}</h2>
          {exploratory.sessions === 0 ? (
            <p className="muted">{t('qaMetrics.noSessions')}</p>
          ) : (
            <>
              <div className="metrics">
                <Kpi label={t('qaMetrics.sessions')} value={String(exploratory.sessions)} />
                <Kpi label={t('qaMetrics.findings')} value={String(exploratory.findings)} />
                <Kpi
                  label={t('qaMetrics.defectsFromFindings')}
                  value={String(exploratory.defectsCreated)}
                />
                <Kpi
                  label={t('qaMetrics.activeTime')}
                  value={t('qaMetrics.hours', {
                    hours: Math.round((exploratory.activeSeconds / 3600) * 10) / 10,
                  })}
                />
              </div>
              <ul className="plain-list">
                {Object.entries(exploratory.byStatus).map(([status, count]) => (
                  <li key={status}>
                    {humanize(status)}: {count}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <BarList
          title={t('qaMetrics.findingsBySeverity')}
          rows={
            exploratory.findings === 0
              ? []
              : DEFECT_SEVERITIES.map((severity) => ({
                  key: severity,
                  label: humanize(severity),
                  value: exploratory.findingsBySeverity[severity],
                }))
          }
        />
      </div>
    </>
  );
}

function ProgressTable({
  id,
  title,
  empty,
  rows,
  href,
}: {
  id: string;
  title: string;
  empty: string;
  rows: readonly QaMetricsProgressRow[];
  href: (row: QaMetricsProgressRow) => string;
}): React.JSX.Element {
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="table-scroll">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">{t('qaMetrics.name')}</th>
                <th scope="col">{t('qaMetrics.status')}</th>
                <th scope="col">{t('qaMetrics.cases')}</th>
                <th scope="col">{t('qaMetrics.completion')}</th>
                <th scope="col">{t('qaMetrics.passRate')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={href(row)}>{row.name}</Link>
                  </td>
                  <td>{humanize(row.status)}</td>
                  <td>
                    {row.executed}/{row.total}
                  </td>
                  <td>{formatPercent(row.completion)}</td>
                  <td>{formatPercent(row.passRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
