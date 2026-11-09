import { TEST_CYCLE_TRANSITIONS } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testCyclesApi, testRunsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { TEST_CYCLE_TONE } from './TestCyclesSection';

const ACTION_OF = {
  active: 'start',
  completed: 'complete',
  cancelled: 'cancel',
  archived: 'archive',
} as const;

/** One test cycle (S7-F2): target, lifecycle, runs, progress and defects. */
export function TestCycleDetailPage(): React.JSX.Element {
  const { cycleId = '' } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [runId, setRunId] = useState('');
  const cycle = useQuery({
    queryKey: ['test-cycle', cycleId],
    queryFn: () => testCyclesApi.get(cycleId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const progress = useQuery({
    queryKey: ['test-cycle', cycleId, 'progress'],
    queryFn: () => testCyclesApi.progress(cycleId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const projectId = cycle.data?.projectId ?? null;
  const { can } = useProjectPermissions(projectId);
  const runs = useQuery({
    queryKey: ['test-runs', projectId, 'cycle-detail'],
    queryFn: () => testRunsApi.list({ projectId: projectId ?? '' }),
    enabled: projectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutate = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['test-cycle'] });
      await queryClient.invalidateQueries({ queryKey: ['test-cycles'] });
    },
    onError: async (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not update the cycle.');
      await queryClient.invalidateQueries({ queryKey: ['test-cycle'] });
    },
  });
  const data = cycle.data;
  const stats = progress.data;
  const editable = data !== undefined && (data.status === 'planned' || data.status === 'active');
  const canEdit = can('testruns.create') && editable;
  return (
    <DataState isPending={cycle.isPending} error={cycle.error} isEmpty={false}>
      {data !== undefined && (
        <>
          <PageHeader title={`Test cycle ${data.name}`} description={data.description ?? ''} />
          <p>
            <Link to={`/test-plans/${data.testPlan.id}`}>← Plan {data.testPlan.name}</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="cycle-summary">
            <h2 id="cycle-summary">Summary</h2>
            <p>
              <span data-testid="cycle-status">
                <Badge tone={TEST_CYCLE_TONE[data.status]}>{humanize(data.status)}</Badge>
              </span>{' '}
              <span className="muted" data-testid="cycle-scope">
                {data.scope.caseCount} cases
                {data.scope.frozen
                  ? ` · scope frozen from plan v${data.scope.planVersion ?? 0}`
                  : ' · follows the plan scope'}
              </span>
            </p>
            <ul aria-label="Cycle facts">
              <li>Owner: {data.owner?.fullName ?? 'nobody'}</li>
              <li>
                Environment:{' '}
                {data.environment === null ? (
                  'any'
                ) : (
                  <Link to={`/environments/${data.environment.id}`}>{data.environment.name}</Link>
                )}
              </li>
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
                Dates: {data.startDate ?? '—'} → {data.endDate ?? '—'}
              </li>
            </ul>
            {can('testruns.manage') && (
              <p>
                {TEST_CYCLE_TRANSITIONS[data.status]
                  .filter((next): next is keyof typeof ACTION_OF => next !== 'planned')
                  .map((next) => (
                    <Button
                      key={next}
                      size="sm"
                      variant={next === 'active' || next === 'completed' ? 'primary' : 'secondary'}
                      disabled={mutate.isPending}
                      onClick={() => {
                        mutate.mutate(() =>
                          testCyclesApi.action(data.id, ACTION_OF[next], data.version),
                        );
                      }}
                    >
                      {humanize(ACTION_OF[next])} cycle
                    </Button>
                  ))}
              </p>
            )}
          </section>
          {canEdit && (
            <section className="card" aria-labelledby="cycle-edit">
              <h2 id="cycle-edit">Edit</h2>
              <TextField
                label="Cycle description"
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
                    testCyclesApi.update(data.id, {
                      description:
                        description?.trim() === '' ? null : (description?.trim() ?? null),
                      version: data.version,
                    }),
                  );
                }}
              >
                Save cycle description
              </Button>
            </section>
          )}
          <section className="card" aria-labelledby="cycle-runs">
            <h2 id="cycle-runs">Runs</h2>
            {data.runs.length === 0 ? (
              <p className="muted">No run attached.</p>
            ) : (
              <ul aria-label="Cycle runs">
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
                            mutate.mutate(() => testCyclesApi.detachRun(data.id, entry.id));
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
                  label="Attach run to cycle"
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
                      await testCyclesApi.attachRun(data.id, runId);
                      setRunId('');
                    });
                  }}
                >
                  Attach run to cycle
                </Button>
              </>
            )}
          </section>
          {stats !== undefined && (
            <section className="card" aria-labelledby="cycle-progress">
              <h2 id="cycle-progress">Progress</h2>
              <ul aria-label="Cycle metrics">
                <li data-testid="cycle-completion">Completion: {stats.completion}%</li>
                <li data-testid="cycle-pass-rate">
                  Pass rate: {stats.passRate === null ? 'n/a' : `${stats.passRate}%`}
                </li>
                <li data-testid="cycle-coverage">
                  Coverage: {stats.coverage.planned}/{stats.coverage.total} (
                  {stats.coverage.percent}%)
                </li>
                <li data-testid="cycle-counts">
                  passed {stats.counts.passed} · failed {stats.counts.failed} · blocked{' '}
                  {stats.counts.blocked} · untested {stats.counts.untested}
                </li>
                <li data-testid="cycle-defects">
                  Defects found: {stats.defects.open} open of {stats.defects.total}
                </li>
              </ul>
              <table className="table" aria-label="Cycle cases">
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Status</th>
                    <th scope="col">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.cases.map((entry) => (
                    <tr key={entry.testCaseId} data-testid={`cycle-case-${entry.key}`}>
                      <td>
                        <Link to={`/test-cases/${entry.testCaseId}`}>{entry.key}</Link>{' '}
                        {entry.title}
                      </td>
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
                <ul aria-label="Cycle defects">
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
