import { RECORDABLE_RESULT_STATUSES } from '@qa-flow-hub/shared';
import type { RecordableResultStatus, RunCaseView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, TextAreaField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { defectsApi, testRunsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';

/**
 * The execution screen.
 *
 * It renders the frozen snapshot, not the live case: a tester must see the
 * steps as they were when the run was created, otherwise an edit mid-run
 * silently changes what "passed" meant.
 */
export function RunExecutionPage(): React.JSX.Element {
  const { runId = '' } = useParams();
  const queryClient = useQueryClient();
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [defectFor, setDefectFor] = useState<{ resultId: string; title: string } | null>(null);

  const run = useQuery({ queryKey: ['run', runId], queryFn: () => testRunsApi.get(runId) });
  const cases = useQuery({
    queryKey: ['run-cases', runId],
    queryFn: () => testRunsApi.cases(runId),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['run', runId] });
    await queryClient.invalidateQueries({ queryKey: ['run-cases', runId] });
    await queryClient.invalidateQueries({ queryKey: ['runs'] });
  };

  const record = useMutation({
    mutationFn: (input: { runCase: RunCaseView; status: RecordableResultStatus }) =>
      testRunsApi.recordResult(runId, input.runCase.id, {
        status: input.status,
        comment: comment === '' ? null : comment,
      }),
    onSuccess: async (result, variables) => {
      setComment('');
      setError(null);
      // A failed result is the only honest starting point for a defect, so the
      // shortcut appears exactly there and carries the result id with it.
      setDefectFor(
        variables.status === 'failed' || variables.status === 'blocked'
          ? { resultId: result.id, title: variables.runCase.snapshot.title }
          : null,
      );
      await refresh();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not record the result.');
    },
  });

  const start = useMutation({ mutationFn: () => testRunsApi.start(runId), onSuccess: refresh });
  const complete = useMutation({
    mutationFn: () => testRunsApi.complete(runId),
    onSuccess: refresh,
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not complete the run.');
    },
  });

  const raiseDefect = useMutation({
    mutationFn: (input: { resultId: string; title: string }) =>
      defectsApi.create({
        projectId: run.data?.projectId ?? '',
        title: `${input.title} fails`,
        severity: 'major',
        priority: 'high',
        testResultId: input.resultId,
        requirementIds: [],
      }),
    onSuccess: () => {
      setDefectFor(null);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not raise the defect.');
    },
  });

  return (
    <>
      <PageHeader
        title={run.data?.name ?? 'Run'}
        description="Results are append-only: a re-execution adds a row, it never overwrites one."
        actions={<Link to="/test-runs">Back to runs</Link>}
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState isPending={run.isPending} error={run.error}>
        {run.data !== undefined && (
          <section className="card">
            <p>
              <Badge tone={toneFor(run.data.status)}>{humanize(run.data.status)}</Badge>{' '}
              {run.data.progress.executed} of {run.data.progress.total} executed —{' '}
              {run.data.progress.completion}%
            </p>
            <div className="row-actions">
              <Button
                variant="secondary"
                disabled={run.data.status !== 'planned'}
                loading={start.isPending}
                onClick={() => {
                  start.mutate();
                }}
              >
                Start run
              </Button>
              <Button
                variant="secondary"
                disabled={run.data.status !== 'in_progress'}
                loading={complete.isPending}
                onClick={() => {
                  complete.mutate();
                }}
              >
                Complete run
              </Button>
            </div>
          </section>
        )}
      </DataState>

      {defectFor !== null && (
        <section className="card" role="status">
          <p>The result was not a pass. Raise a defect linked to it?</p>
          <div className="row-actions">
            <Button
              loading={raiseDefect.isPending}
              onClick={() => {
                raiseDefect.mutate(defectFor);
              }}
            >
              Raise defect
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDefectFor(null);
              }}
            >
              Dismiss
            </Button>
          </div>
        </section>
      )}

      <DataState
        isPending={cases.isPending}
        error={cases.error}
        isEmpty={(cases.data?.data.length ?? 0) === 0}
        emptyMessage="This run has no cases."
      >
        <ul className="plain-list">
          {cases.data?.data.map((runCase) => (
            <li key={runCase.id} className="card run-case">
              <div className="run-case__header">
                <button
                  className="tree-item"
                  aria-expanded={openCase === runCase.id}
                  onClick={() => {
                    setOpenCase(openCase === runCase.id ? null : runCase.id);
                  }}
                >
                  <code>{runCase.snapshot.key}</code> {runCase.snapshot.title}
                </button>
                <Badge tone={toneFor(runCase.latestStatus)}>{humanize(runCase.latestStatus)}</Badge>
              </div>

              {openCase === runCase.id && (
                <div>
                  <p className="muted">Frozen at version {runCase.caseVersion}.</p>
                  {runCase.snapshot.steps.length === 0 ? (
                    <p className="muted">This case had no steps when the run was created.</p>
                  ) : (
                    <ol>
                      {runCase.snapshot.steps.map((step) => (
                        <li key={step.position}>
                          {step.action}
                          {step.expectedResult !== null && (
                            <div className="muted">Expected: {step.expectedResult}</div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}

                  <TextAreaField
                    label="Comment"
                    value={comment}
                    onChange={(event) => {
                      setComment(event.target.value);
                    }}
                  />
                  <div className="row-actions">
                    {RECORDABLE_RESULT_STATUSES.map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === 'passed' ? 'primary' : 'secondary'}
                        loading={record.isPending}
                        onClick={() => {
                          record.mutate({ runCase, status });
                        }}
                      >
                        {humanize(status)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </DataState>
    </>
  );
}
