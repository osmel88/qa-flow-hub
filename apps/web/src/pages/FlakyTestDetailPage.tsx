import { FLAKY_SOURCES } from '@qa-flow-hub/shared';
import type { FlakyMarkState, FlakySource } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { flakyApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { FLAKY_TONE, percent } from './FlakyTestsPage';

const MARK_LABEL: Record<FlakyMarkState, string> = {
  flaky: 'Confirm flaky',
  not_flaky: 'Dismiss (not flaky)',
  cleared: 'Clear mark',
};

/** Stability of one case: metrics, the rules applied, its result history and marks. */
export function FlakyTestDetailPage(): React.JSX.Element {
  const { testCaseId = '' } = useParams();
  const { activeProjectId } = useProject();
  const { can } = useProjectPermissions(activeProjectId);
  const queryClient = useQueryClient();
  const [source, setSource] = useState<FlakySource>('all');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['flaky-test', testCaseId, source],
    queryFn: () => flakyApi.get(testCaseId, { source }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mark = useMutation({
    mutationFn: (state: FlakyMarkState) =>
      flakyApi.mark(testCaseId, { state, reason: reason.trim() }),
    onSuccess: async () => {
      setReason('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['flaky-test', testCaseId] });
      await queryClient.invalidateQueries({ queryKey: ['flaky-tests'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the mark.');
    },
  });
  const data = detail.data;
  return (
    <DataState isPending={detail.isPending} error={detail.error} isEmpty={data === undefined}>
      {data !== undefined && (
        <>
          <PageHeader
            title={`Stability of ${data.testCase.key}`}
            description={data.testCase.title}
          />
          <p>
            <Link to="/flaky-tests">← Flaky tests</Link> ·{' '}
            <Link to={`/test-cases/${data.testCase.id}`}>Open test case</Link>
          </p>
          <section className="card" aria-labelledby="stability-heading">
            <h2 id="stability-heading">Stability</h2>
            <p>
              <Badge tone={FLAKY_TONE[data.status]}>
                <span data-testid="flaky-status">{humanize(data.status)}</span>
              </Badge>{' '}
              detected: {humanize(data.detectedStatus)}
              {data.confirmed && ' · confirmed by a person'}
              {data.dismissed && ' · dismissed by a person until a new flip'}
            </p>
            <p data-testid="flaky-metrics">
              {data.executions} executions · pass rate {percent(data.passRate)} · fail rate{' '}
              {percent(data.failRate)} · {data.flips} flips in {data.comparisons} comparisons (flip
              rate {percent(data.flipRate)})
            </p>
            <p>
              <small>
                Rules: latest {data.rules.window} passed/failed results; fewer than{' '}
                {data.rules.minExecutions} is insufficient data; flaky needs at least{' '}
                {data.rules.minFlips} flips and a flip rate of {percent(data.rules.minFlipRate)};
                failing means the last {data.rules.failingTail} results failed. Results are compared
                within the same dataset row and case version.
              </small>
            </p>
            <SelectField
              label="Result source"
              value={source}
              options={FLAKY_SOURCES.map((entry) => ({ value: entry, label: humanize(entry) }))}
              onChange={(event) => {
                setSource(event.target.value as FlakySource);
              }}
            />
          </section>
          {can('test_design.write') && (
            <section className="card" aria-labelledby="mark-heading">
              <h2 id="mark-heading">Manual mark</h2>
              {error !== null && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <TextAreaField
                label="Mark reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              {(Object.keys(MARK_LABEL) as FlakyMarkState[]).map((state) => (
                <Button
                  key={state}
                  variant="secondary"
                  loading={mark.isPending && mark.variables === state}
                  disabled={reason.trim().length < 3}
                  onClick={() => {
                    mark.mutate(state);
                  }}
                >
                  {MARK_LABEL[state]}
                </Button>
              ))}
            </section>
          )}
          <section className="card" aria-labelledby="history-heading">
            <h2 id="history-heading">Result history</h2>
            <DataState
              isPending={false}
              error={null}
              isEmpty={data.history.length === 0}
              emptyMessage="No passed or failed result yet."
            >
              <table className="table" aria-label="Result history">
                <thead>
                  <tr>
                    <th scope="col">Executed</th>
                    <th scope="col">Result</th>
                    <th scope="col">Run</th>
                    <th scope="col">Source</th>
                    <th scope="col">Version</th>
                    <th scope="col">Dataset row</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((entry) => (
                    <tr key={entry.resultId} data-testid={`history-${entry.resultId}`}>
                      <td>{new Date(entry.executedAt).toLocaleString()}</td>
                      <td>
                        {entry.status}
                        {entry.flip && <small> · flip</small>}
                      </td>
                      <td>
                        <Link to={`/test-runs/${entry.run.id}`}>{entry.run.name}</Link>
                      </td>
                      <td>{entry.source}</td>
                      <td>{entry.caseVersion === null ? '—' : `v${entry.caseVersion}`}</td>
                      <td>{entry.iterationLabel ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataState>
          </section>
          <section className="card" aria-labelledby="marks-heading">
            <h2 id="marks-heading">Mark history</h2>
            {data.marks.length === 0 ? (
              <p>No mark yet.</p>
            ) : (
              <ul aria-label="Mark history">
                {data.marks.map((entry) => (
                  <li key={`${entry.markedAt}-${entry.state}`}>
                    {humanize(entry.state)} by {entry.markedBy?.fullName ?? 'a former member'} on{' '}
                    {new Date(entry.markedAt).toLocaleString()}: {entry.reason}
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
