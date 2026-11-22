import { DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { testRunsApi } from '../api/endpoints';
import { humanize } from '../components/status';
import { PrintToolbar } from './PrintableMatrixPage';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

/** Print-friendly run summary, built from the run's case snapshots. */
export function PrintableRunPage(): React.JSX.Element {
  const { runId = '' } = useParams();
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => testRunsApi.get(runId) });
  const cases = useQuery({
    queryKey: ['run-cases', runId],
    queryFn: () => testRunsApi.cases(runId),
  });

  return (
    <main className="print-page">
      <PrintToolbar />
      <DataState isPending={run.isPending || cases.isPending} error={run.error ?? cases.error}>
        {run.data !== undefined && (
          <>
            <h1>
              {t('printableRun.testRun')} {run.data.name}
            </h1>
            <p className="muted">
              {humanize(run.data.status)}
              {run.data.milestone === null ? '' : ` · ${run.data.milestone}`}
              {run.data.environment === null ? '' : ` · ${run.data.environment}`}{' '}
              {t('printableRun.generated')} {formatDateTime(new Date())}
            </p>
            <p>
              {run.data.progress.executed} {t('printableRun.of')} {run.data.progress.total}{' '}
              {t('printableRun.executed')}
              {run.data.progress.completion}%): {run.data.progress.passed}{' '}
              {t('printableRun.passed')} {run.data.progress.failed} {t('printableRun.failed')}{' '}
              {run.data.progress.blocked} {t('printableRun.blocked')} {run.data.progress.skipped}{' '}
              {t('printableRun.skipped')}
            </p>
          </>
        )}
        {cases.data !== undefined && (
          <table className="print-table" aria-label={t('printableRun.runCases')}>
            <thead>
              <tr>
                <th scope="col">{t('printableRun.key')}</th>
                <th scope="col">{t('printableRun.title')}</th>
                <th scope="col">{t('printableRun.priority')}</th>
                <th scope="col">{t('printableRun.version')}</th>
                <th scope="col">{t('printableRun.status')}</th>
              </tr>
            </thead>
            <tbody>
              {cases.data.data.map((runCase) => (
                <tr key={runCase.id}>
                  <td>{runCase.snapshot.key}</td>
                  <td>{runCase.snapshot.title}</td>
                  <td>{humanize(runCase.snapshot.priority)}</td>
                  <td>v{runCase.caseVersion}</td>
                  <td>{humanize(runCase.latestStatus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DataState>
    </main>
  );
}
