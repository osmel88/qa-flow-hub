import { TEST_PLAN_TRANSITIONS } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testDesignApi, testPlansApi, testRunsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { TEST_PLAN_TONE } from './TestPlansPage';
import { TestCyclesSection } from './TestCyclesSection';

const ACTION_OF = {
  active: 'start',
  completed: 'complete',
  cancelled: 'cancel',
  archived: 'archive',
} as const;

/** One test plan (S7-F1): scope, lifecycle, runs, progress and defects. */
export function TestPlanDetailPage(): React.JSX.Element {
  const { planId = '' } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [suiteId, setSuiteId] = useState('');
  const [runId, setRunId] = useState('');
  const plan = useQuery({
    queryKey: ['test-plan', planId],
    queryFn: () => testPlansApi.get(planId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const progress = useQuery({
    queryKey: ['test-plan', planId, 'progress'],
    queryFn: () => testPlansApi.progress(planId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const projectId = plan.data?.projectId ?? null;
  const { can } = useProjectPermissions(projectId);
  const suites = useQuery({
    queryKey: ['suites', projectId, 'plan-detail'],
    queryFn: () => testDesignApi.suites(projectId ?? ''),
    enabled: projectId !== null,
  });
  const runs = useQuery({
    queryKey: ['test-runs', projectId, 'plan-detail'],
    queryFn: () => testRunsApi.list({ projectId: projectId ?? '' }),
    enabled: projectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const refresh = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['test-plan'] });
    await queryClient.invalidateQueries({ queryKey: ['test-plans'] });
  };
  const onError = async (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Could not update the test plan.');
    await queryClient.invalidateQueries({ queryKey: ['test-plan'] });
  };
  const mutate = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: refresh,
    onError,
  });
  const data = plan.data;
  const stats = progress.data;
  const editable = data !== undefined && (data.status === 'draft' || data.status === 'active');
  const canEdit = can('testruns.create') && editable;
  return (
    <DataState isPending={plan.isPending} error={plan.error} isEmpty={false}>
      {data !== undefined && (
        <>
          <PageHeader title={`Test plan ${data.name}`} description={data.description ?? ''} />
          <p>
            <Link to="/test-plans">← All test plans</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="plan-summary">
            <h2 id="plan-summary">Summary</h2>
            <p>
              <span data-testid="plan-status">
                <Badge tone={TEST_PLAN_TONE[data.status]}>{humanize(data.status)}</Badge>
              </span>{' '}
              <span className="muted" data-testid="plan-scope">
                {data.scope.caseCount} cases
                {data.scope.frozen ? ` · scope frozen (v${data.scope.version})` : ' · live scope'}
              </span>
            </p>
            <ul aria-label="Plan facts">
              <li>Owner: {data.owner?.fullName ?? 'nobody'}</li>
              <li>
                Release:{' '}
                {data.release === null ? (
                  'none'
                ) : (
                  <Link to={`/releases/${data.release.id}`}>
                    {data.release.version} · {data.release.name}
                  </Link>
                )}
              </li>
              <li>
                Environments:{' '}
                {data.environments.length === 0
                  ? 'none'
                  : data.environments.map((env, index) => (
                      <span key={env.id}>
                        {index > 0 && ', '}
                        <Link to={`/environments/${env.id}`}>{env.name}</Link>
                      </span>
                    ))}
              </li>
              <li>
                Dates: {data.startDate ?? '—'} → {data.endDate ?? '—'}
              </li>
              <li>Suites: {data.suites.map((entry) => entry.name).join(', ') || 'none'}</li>
              <li>
                Direct cases: {data.directCases.map((entry) => entry.key).join(', ') || 'none'}
              </li>
            </ul>
            {can('testruns.manage') && (
              <p>
                {TEST_PLAN_TRANSITIONS[data.status]
                  .filter((next): next is keyof typeof ACTION_OF => next !== 'draft')
                  .map((next) => (
                    <Button
                      key={next}
                      size="sm"
                      variant={next === 'active' || next === 'completed' ? 'primary' : 'secondary'}
                      disabled={mutate.isPending}
                      onClick={() => {
                        mutate.mutate(() =>
                          testPlansApi.action(data.id, ACTION_OF[next], data.version),
                        );
                      }}
                    >
                      {humanize(ACTION_OF[next])} plan
                    </Button>
                  ))}
              </p>
            )}
            {canEdit && data.scope.frozen && (
              <Button
                size="sm"
                variant="secondary"
                disabled={mutate.isPending}
                onClick={() => {
                  mutate.mutate(() => testPlansApi.action(data.id, 'scope/refresh', data.version));
                }}
              >
                Refresh frozen scope
              </Button>
            )}
          </section>
          {canEdit && (
            <section className="card" aria-labelledby="plan-edit">
              <h2 id="plan-edit">Edit</h2>
              <TextField
                label="Plan description"
                value={description ?? data.description ?? ''}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
              <Button
                size="sm"
                disabled={mutate.isPending || description === null}
                onClick={() => {
                  mutate.mutate(() =>
                    testPlansApi.update(data.id, {
                      description:
                        description?.trim() === '' ? null : (description?.trim() ?? null),
                      version: data.version,
                    }),
                  );
                }}
              >
                Save description
              </Button>
              {!data.scope.frozen && (
                <>
                  <SelectField
                    label="Add suite to plan"
                    value={suiteId}
                    options={[
                      { value: '', label: 'Choose a suite' },
                      ...(suites.data ?? [])
                        .filter((entry) => !data.suites.some((own) => own.id === entry.id))
                        .map((entry) => ({ value: entry.id, label: entry.name })),
                    ]}
                    onChange={(event) => {
                      setSuiteId(event.target.value);
                    }}
                  />
                  <Button
                    size="sm"
                    disabled={mutate.isPending || suiteId === ''}
                    onClick={() => {
                      mutate.mutate(async () => {
                        await testPlansApi.update(data.id, {
                          suiteIds: [...data.suites.map((entry) => entry.id), suiteId],
                          version: data.version,
                        });
                        setSuiteId('');
                      });
                    }}
                  >
                    Add suite
                  </Button>
                </>
              )}
            </section>
          )}
          <section className="card" aria-labelledby="plan-runs">
            <h2 id="plan-runs">Runs</h2>
            {data.runs.length === 0 ? (
              <p className="muted">No run attached.</p>
            ) : (
              <ul aria-label="Plan runs">
                {data.runs.map((entry) => (
                  <li key={entry.id}>
                    <Link to={`/test-runs/${entry.id}`}>{entry.name}</Link> ·{' '}
                    {humanize(entry.status)}
                    {canEdit && (
                      <>
                        {' '}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            mutate.mutate(() => testPlansApi.detachRun(data.id, entry.id));
                          }}
                        >
                          Detach
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <>
                <SelectField
                  label="Attach run"
                  value={runId}
                  options={[
                    { value: '', label: 'Choose a run' },
                    ...(runs.data?.data ?? [])
                      .filter((entry) => !data.runs.some((own) => own.id === entry.id))
                      .map((entry) => ({ value: entry.id, label: entry.name })),
                  ]}
                  onChange={(event) => {
                    setRunId(event.target.value);
                  }}
                />
                <Button
                  size="sm"
                  disabled={mutate.isPending || runId === ''}
                  onClick={() => {
                    mutate.mutate(async () => {
                      await testPlansApi.attachRun(data.id, runId);
                      setRunId('');
                    });
                  }}
                >
                  Attach run
                </Button>
              </>
            )}
          </section>
          <TestCyclesSection plan={data} canCreate={can('testruns.create') && editable} />
          {stats !== undefined && (
            <section className="card" aria-labelledby="plan-progress">
              <h2 id="plan-progress">Progress</h2>
              <ul aria-label="Plan metrics">
                <li data-testid="plan-completion">Completion: {stats.completion}%</li>
                <li data-testid="plan-pass-rate">
                  Pass rate: {stats.passRate === null ? 'n/a' : `${stats.passRate}%`}
                </li>
                <li data-testid="plan-coverage">
                  Coverage: {stats.coverage.planned}/{stats.coverage.total} (
                  {stats.coverage.percent}%)
                </li>
                <li data-testid="plan-counts">
                  passed {stats.counts.passed} · failed {stats.counts.failed} · blocked{' '}
                  {stats.counts.blocked} · untested {stats.counts.untested}
                </li>
                <li data-testid="plan-defects">
                  Defects: {stats.defects.open} open of {stats.defects.total}
                </li>
              </ul>
              <table className="table" aria-label="Plan cases">
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Suite</th>
                    <th scope="col">Status</th>
                    <th scope="col">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.cases.map((entry) => (
                    <tr key={entry.testCaseId} data-testid={`plan-case-${entry.key}`}>
                      <td>
                        <Link to={`/test-cases/${entry.testCaseId}`}>{entry.key}</Link>{' '}
                        {entry.title}
                        {entry.source === 'direct' && ' (direct)'}
                      </td>
                      <td>{entry.suite ?? 'none'}</td>
                      <td>{humanize(entry.status)}</td>
                      <td>
                        {entry.run === null ? (
                          'not planned'
                        ) : (
                          <Link to={`/test-runs/${entry.run.id}`}>{entry.run.name}</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stats.defects.items.length > 0 && (
                <ul aria-label="Plan defects">
                  {stats.defects.items.map((entry) => (
                    <li key={entry.id}>
                      <Link to="/defects">{entry.key}</Link> {entry.title} ·{' '}
                      {humanize(entry.severity)} · {humanize(entry.status)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </DataState>
  );
}
