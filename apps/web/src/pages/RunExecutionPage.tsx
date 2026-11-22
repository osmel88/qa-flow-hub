import { RECORDABLE_RESULT_STATUSES, isOpenRelease } from '@qa-flow-hub/shared';
import type {
  TestRunView,
  ExternalReferenceView,
  RecordableResultStatus,
  RunCaseView,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { defectsApi, exportsApi, releasesApi, testRunsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { AttachmentsPanel } from '../components/AttachmentsPanel';
import { ExportButton } from '../components/ExportButton';
import { useProjectPermissions } from '../components/use-project-permissions';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { invalidateAfterResult } from './run-execution-cache';
import {
  GitHubResultOrigin,
  GitHubRunPanel,
  useGitHubReferences,
} from '../components/GitHubRunPanel';
import { TestRailSyncCell, useTestRailReferences } from '../components/TestRailSyncCell';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

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
  const [datasetFilter, setDatasetFilter] = useState('');
  const [defectFor, setDefectFor] = useState<{ resultId: string; title: string } | null>(null);

  const run = useQuery({ queryKey: ['run', runId], queryFn: () => testRunsApi.get(runId) });
  const { can } = useProjectPermissions(run.data?.projectId ?? null);
  const cases = useQuery({
    queryKey: ['run-cases', runId],
    queryFn: () => testRunsApi.cases(runId),
  });

  const refresh = () => invalidateAfterResult(queryClient, runId);
  const datasetLabels = [
    ...new Set(
      (cases.data?.data ?? []).flatMap((entry) =>
        entry.iteration === null ? [] : [entry.iteration.label],
      ),
    ),
  ];
  const shownCases = (cases.data?.data ?? []).filter(
    (entry) =>
      datasetFilter === '' ||
      (datasetFilter === '__plain'
        ? entry.iteration === null
        : entry.iteration?.label === datasetFilter),
  );

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
      setError(
        cause instanceof ApiError ? cause.message : t('runExecution.couldNotRecordTheResult'),
      );
    },
  });

  const runReferences = useTestRailReferences(
    { entityType: 'test_run', projectId: run.data?.projectId ?? '' },
    run.data !== undefined,
  );
  const resultReferences = useTestRailReferences({ entityType: 'test_result', testRunId: runId });
  const gitHubRunReferences = useGitHubReferences(
    { entityType: 'test_run', projectId: run.data?.projectId ?? '' },
    run.data !== undefined,
  );
  const gitHubResultReferences = useGitHubReferences({
    entityType: 'test_result',
    testRunId: runId,
  });

  const start = useMutation({ mutationFn: () => testRunsApi.start(runId), onSuccess: refresh });
  const complete = useMutation({
    mutationFn: () => testRunsApi.complete(runId),
    onSuccess: refresh,
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('runExecution.couldNotCompleteTheRun'),
      );
    },
  });

  const raiseDefect = useMutation({
    mutationFn: (input: { resultId: string; title: string }) =>
      defectsApi.create({
        projectId: run.data?.projectId ?? '',
        title: t('runExecution.fails', { title: input.title }),
        severity: 'major',
        priority: 'high',
        testResultId: input.resultId,
        requirementIds: [],
        customFields: {},
      }),
    onSuccess: () => {
      setDefectFor(null);
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('runExecution.couldNotRaiseTheDefect'),
      );
    },
  });

  return (
    <>
      <PageHeader
        title={run.data?.name ?? t('runExecution.run')}
        description={t('runExecution.resultsAreAppendOnlyA')}
        actions={
          <>
            {can('data.export') && (
              <>
                <ExportButton
                  label={t('runExecution.exportCsv')}
                  fallbackName="test-run.csv"
                  download={() => exportsApi.testRun(runId)}
                />
                <Link to={`/print/test-runs/${runId}`} target="_blank" rel="noopener">
                  {t('runExecution.printableView')}
                </Link>
              </>
            )}
            <Link to="/test-runs">{t('runExecution.backToRuns')}</Link>
          </>
        }
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      {run.data !== undefined &&
        can('testruns.create') &&
        (run.data.status === 'planned' || run.data.status === 'in_progress') && (
          <EditRun run={run.data} />
        )}

      <DataState isPending={run.isPending} error={run.error}>
        {run.data !== undefined && (
          <section className="card">
            <p>
              <Badge tone={toneFor(run.data.status)}>{humanize(run.data.status)}</Badge>{' '}
              {run.data.progress.executed} {t('runExecution.of')} {run.data.progress.total}{' '}
              {t('runExecution.executed')} {run.data.progress.completion}%
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
                {t('runExecution.startRun')}
              </Button>
              <Button
                variant="secondary"
                disabled={run.data.status !== 'in_progress'}
                loading={complete.isPending}
                onClick={() => {
                  complete.mutate();
                }}
              >
                {t('runExecution.completeRun')}
              </Button>
              <TestRailSyncCell
                entityType="test_run"
                entityId={runId}
                reference={runReferences.data?.get(runId)}
              />
            </div>
            <AttachmentsPanel
              entityType="test_run"
              entityId={runId}
              title={t('runExecution.runEvidence')}
            />
          </section>
        )}
      </DataState>

      {run.data !== undefined && (
        <GitHubRunPanel
          testRunId={runId}
          runStatus={run.data.status}
          reference={gitHubRunReferences.data?.get(runId)}
          onImported={refresh}
        />
      )}

      {defectFor !== null && (
        <section className="card" role="status">
          <p>{t('runExecution.theResultWasNotA')}</p>
          <div className="row-actions">
            <Button
              loading={raiseDefect.isPending}
              onClick={() => {
                raiseDefect.mutate(defectFor);
              }}
            >
              {t('runExecution.raiseDefect')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDefectFor(null);
              }}
            >
              {t('runExecution.dismiss')}
            </Button>
          </div>
        </section>
      )}

      <DataState
        isPending={cases.isPending}
        error={cases.error}
        isEmpty={(cases.data?.data.length ?? 0) === 0}
        emptyMessage={t('runExecution.thisRunHasNoCases')}
      >
        {datasetLabels.length > 0 && (
          <label className="ui-field">
            <span className="ui-field__label">{t('runExecution.datasetRow')}</span>
            <select
              value={datasetFilter}
              onChange={(event) => {
                setDatasetFilter(event.target.value);
              }}
            >
              <option value="">{t('runExecution.allExecutions')}</option>
              <option value="__plain">{t('runExecution.withoutDataset')}</option>
              {datasetLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="plain-list">
          {shownCases.map((runCase) => (
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
                  {runCase.iteration !== null && (
                    <span className="muted"> [{runCase.iteration.label}]</span>
                  )}
                </button>
                <Badge tone={toneFor(runCase.latestStatus)}>{humanize(runCase.latestStatus)}</Badge>
              </div>

              {openCase === runCase.id && (
                <div>
                  <p className="muted">
                    {t('runExecution.executedVersion')}{' '}
                    <Link to={`/test-cases/${runCase.testCaseId}?version=${runCase.caseVersion}`}>
                      v{runCase.caseVersion}
                    </Link>
                    .
                  </p>
                  {runCase.iteration !== null && <ParameterValues runCase={runCase} />}
                  {runCase.snapshot.steps.length === 0 ? (
                    <p className="muted">{t('runExecution.thisCaseHadNoSteps')}</p>
                  ) : (
                    <ol>
                      {runCase.snapshot.steps.map((step) => (
                        <li key={step.position}>
                          {step.action}
                          {step.data !== null && (
                            <div className="muted">
                              {t('runExecution.data')} {step.data}
                            </div>
                          )}
                          {step.expectedResult !== null && (
                            <div className="muted">
                              {t('runExecution.expected')} {step.expectedResult}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}

                  <LatestResult
                    runId={runId}
                    runCase={runCase}
                    references={resultReferences.data}
                    gitHubReferences={gitHubResultReferences.data}
                  />

                  <TextAreaField
                    label={t('runExecution.comment')}
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

interface LatestResultProps {
  runId: string;
  runCase: RunCaseView;
  references: Map<string, ExternalReferenceView> | undefined;
  gitHubReferences: Map<string, ExternalReferenceView> | undefined;
}

/**
 * Only the newest attempt is offered for TestRail: results are append-only on
 * both sides, so syncing an older one would push history out of order.
 */
function LatestResult({
  runId,
  runCase,
  references,
  gitHubReferences,
}: LatestResultProps): React.JSX.Element | null {
  const results = useQuery({
    queryKey: ['run-case-results', runId, runCase.id],
    queryFn: () => testRunsApi.results(runId, runCase.id),
  });
  const latest = results.data?.[0];

  if (latest === undefined) {
    return null;
  }

  return (
    <>
      <div className="external-sync">
        <span className="muted">
          {t('runExecution.latestResult')} {humanize(latest.status)} (
          {formatDateTime(latest.executedAt)})
          {runCase.iteration !== null &&
            t('runExecution.withIteration', { label: runCase.iteration.label })}
          {latest.caseVersion !== null &&
            t('runExecution.onVersion', { version: latest.caseVersion })}
        </span>
        <GitHubResultOrigin reference={gitHubReferences?.get(latest.id)} />
        <TestRailSyncCell
          entityType="test_result"
          entityId={latest.id}
          reference={references?.get(latest.id)}
        />
      </div>
      <AttachmentsPanel
        entityType="test_result"
        entityId={latest.id}
        title={t('runExecution.evidenceForLatestResult', { value: humanize(latest.status) })}
      />
    </>
  );
}

/** The values this execution ran with, frozen when the run included the case. */
function ParameterValues({ runCase }: { runCase: RunCaseView }): React.JSX.Element {
  const values = runCase.iteration?.values ?? {};
  return (
    <dl className="parameter-values" aria-label={t('runExecution.parametersUsed')}>
      {Object.entries(values).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value === null ? '—' : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Edits the run's own fields; recorded results stay append-only. */
export function EditRun({ run }: { run: TestRunView }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(run.name);
  const [description, setDescription] = useState(run.description ?? '');
  const [milestone, setMilestone] = useState(run.milestone ?? '');
  const [environment, setEnvironment] = useState(run.environment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [releaseId, setReleaseId] = useState(run.releaseId ?? '');
  const releases = useQuery({
    queryKey: ['releases', run.projectId],
    queryFn: () => releasesApi.list({ projectId: run.projectId }),
    enabled: open,
  });
  // The API only attaches a run to an open release; the current one stays listed.
  const releaseOptions = [
    { value: '', label: t('runExecution.editNoRelease') },
    ...(releases.data?.data ?? [])
      .filter((release) => isOpenRelease(release.status) || release.id === run.releaseId)
      .map((release) => ({ value: release.id, label: `${release.name} (${release.version})` })),
  ];
  const nameError = name.trim().length < 3 ? t('runExecution.editNameTooShort') : undefined;
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

  const save = useMutation({
    mutationFn: () =>
      testRunsApi.update(run.id, {
        name: name.trim(),
        description: orNull(description),
        milestone: orNull(milestone),
        environment: orNull(environment),
        ...(releaseId === (run.releaseId ?? '')
          ? {}
          : { releaseId: releaseId === '' ? null : releaseId }),
      }),
    onSuccess: async () => {
      setError(null);
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['run', run.id] }),
        queryClient.invalidateQueries({ queryKey: ['runs'] }),
        queryClient.invalidateQueries({ queryKey: ['releases'] }),
      ]);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('runExecution.couldNotSaveTheRun'));
    },
  });

  if (!open) {
    return (
      <div className="actions">
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('runExecution.editRun')}
        </Button>
      </div>
    );
  }

  return (
    <section className="card" aria-labelledby="edit-run">
      <h2 id="edit-run">{t('runExecution.editRun')}</h2>
      <p className="muted">{t('runExecution.editOnlyOpen')}</p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label={t('runExecution.editName')}
          value={name}
          error={nameError}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextAreaField
          label={t('runExecution.editDescription')}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        <TextField
          label={t('runExecution.editMilestone')}
          value={milestone}
          onChange={(event) => {
            setMilestone(event.target.value);
          }}
        />
        <TextField
          label={t('runExecution.editEnvironment')}
          value={environment}
          onChange={(event) => {
            setEnvironment(event.target.value);
          }}
        />
        <SelectField
          label={t('runExecution.editRelease')}
          hint={t('runExecution.editReleaseHint')}
          options={releaseOptions}
          value={releaseId}
          onChange={(event) => {
            setReleaseId(event.target.value);
          }}
        />
        <div className="actions">
          <Button type="submit" loading={save.isPending} disabled={nameError !== undefined}>
            {t('runExecution.editSave')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('runExecution.editCancel')}
          </Button>
        </div>
      </form>
    </section>
  );
}
