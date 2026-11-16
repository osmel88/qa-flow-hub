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
import { t } from '../i18n/i18n';

const MARK_LABEL: Record<FlakyMarkState, string> = {
  get flaky() {
    return t('flakyTestDetail.confirmFlaky');
  },
  get not_flaky() {
    return t('flakyTestDetail.dismissNotFlaky');
  },
  get cleared() {
    return t('flakyTestDetail.clearMark');
  },
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
      setError(
        cause instanceof ApiError ? cause.message : t('flakyTestDetail.couldNotSaveTheMark'),
      );
    },
  });
  const data = detail.data;
  return (
    <DataState isPending={detail.isPending} error={detail.error} isEmpty={data === undefined}>
      {data !== undefined && (
        <>
          <PageHeader
            title={t('flakyTestDetail.stabilityOf', { key: data.testCase.key })}
            description={data.testCase.title}
          />
          <p>
            <Link to="/flaky-tests">{t('flakyTestDetail.flakyTests')}</Link> ·{' '}
            <Link to={`/test-cases/${data.testCase.id}`}>{t('flakyTestDetail.openTestCase')}</Link>
          </p>
          <section className="card" aria-labelledby="stability-heading">
            <h2 id="stability-heading">{t('flakyTestDetail.stability')}</h2>
            <p>
              <Badge tone={FLAKY_TONE[data.status]}>
                <span data-testid="flaky-status">{humanize(data.status)}</span>
              </Badge>{' '}
              {t('flakyTestDetail.detected')} {humanize(data.detectedStatus)}
              {data.confirmed && t('flakyTestDetail.confirmedByAPerson')}
              {data.dismissed && t('flakyTestDetail.dismissedUntilNewFlip')}
            </p>
            <p data-testid="flaky-metrics">
              {data.executions} {t('flakyTestDetail.executionsPassRate')} {percent(data.passRate)}{' '}
              {t('flakyTestDetail.failRate')} {percent(data.failRate)} · {data.flips}{' '}
              {t('flakyTestDetail.flipsIn')} {data.comparisons}{' '}
              {t('flakyTestDetail.comparisonsFlipRate')} {percent(data.flipRate)})
            </p>
            <p>
              <small>
                {t('flakyTestDetail.rulesLatest')} {data.rules.window}{' '}
                {t('flakyTestDetail.passedFailedResultsFewerThan')} {data.rules.minExecutions}{' '}
                {t('flakyTestDetail.isInsufficientDataFlakyNeeds')} {data.rules.minFlips}{' '}
                {t('flakyTestDetail.flipsAndAFlipRate')} {percent(data.rules.minFlipRate)}
                {t('flakyTestDetail.failingMeansTheLast')} {data.rules.failingTail}{' '}
                {t('flakyTestDetail.resultsFailedResultsAreCompared')}
              </small>
            </p>
            <SelectField
              label={t('flakyTestDetail.resultSource')}
              value={source}
              options={FLAKY_SOURCES.map((entry) => ({ value: entry, label: humanize(entry) }))}
              onChange={(event) => {
                setSource(event.target.value as FlakySource);
              }}
            />
          </section>
          {can('test_design.write') && (
            <section className="card" aria-labelledby="mark-heading">
              <h2 id="mark-heading">{t('flakyTestDetail.manualMark')}</h2>
              {error !== null && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <TextAreaField
                label={t('flakyTestDetail.markReason')}
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
            <h2 id="history-heading">{t('flakyTestDetail.resultHistory')}</h2>
            <DataState
              isPending={false}
              error={null}
              isEmpty={data.history.length === 0}
              emptyMessage={t('flakyTestDetail.noPassedOrFailedResult')}
            >
              <table className="table" aria-label={t('flakyTestDetail.resultHistory')}>
                <thead>
                  <tr>
                    <th scope="col">{t('flakyTestDetail.executed')}</th>
                    <th scope="col">{t('flakyTestDetail.result')}</th>
                    <th scope="col">{t('flakyTestDetail.run')}</th>
                    <th scope="col">{t('flakyTestDetail.source')}</th>
                    <th scope="col">{t('flakyTestDetail.version')}</th>
                    <th scope="col">{t('flakyTestDetail.datasetRow')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((entry) => (
                    <tr key={entry.resultId} data-testid={`history-${entry.resultId}`}>
                      <td>{new Date(entry.executedAt).toLocaleString()}</td>
                      <td>
                        {entry.status}
                        {entry.flip && <small> {t('flakyTestDetail.flip')}</small>}
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
            <h2 id="marks-heading">{t('flakyTestDetail.markHistory')}</h2>
            {data.marks.length === 0 ? (
              <p>{t('flakyTestDetail.noMarkYet')}</p>
            ) : (
              <ul aria-label={t('flakyTestDetail.markHistory')}>
                {data.marks.map((entry) => (
                  <li key={`${entry.markedAt}-${entry.state}`}>
                    {humanize(entry.state)} {t('flakyTestDetail.by')}{' '}
                    {entry.markedBy?.fullName ?? t('flakyTestDetail.aFormerMember')}{' '}
                    {t('flakyTestDetail.on')} {new Date(entry.markedAt).toLocaleString()}:{' '}
                    {entry.reason}
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
