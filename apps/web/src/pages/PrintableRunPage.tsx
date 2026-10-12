import { DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { testRunsApi } from '../api/endpoints';
import { humanize } from '../components/status';
import { PrintToolbar } from './PrintableMatrixPage';

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
            <h1>Test run — {run.data.name}</h1>
            <p className="muted">
              {humanize(run.data.status)}
              {run.data.milestone === null ? '' : ` · ${run.data.milestone}`}
              {run.data.environment === null ? '' : ` · ${run.data.environment}`} · Generated{' '}
              {new Date().toLocaleString()}
            </p>
            <p>
              {run.data.progress.executed} of {run.data.progress.total} executed (
              {run.data.progress.completion}%): {run.data.progress.passed} passed,{' '}
              {run.data.progress.failed} failed, {run.data.progress.blocked} blocked,{' '}
              {run.data.progress.skipped} skipped.
            </p>
          </>
        )}
        {cases.data !== undefined && (
          <table className="print-table" aria-label="Run cases">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Title</th>
                <th scope="col">Priority</th>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
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
