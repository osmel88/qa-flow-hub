import { DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { traceabilityApi } from '../api/endpoints';
import { humanize } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

/**
 * Print-friendly traceability matrix: the browser's "Save as PDF" is the PDF
 * export (ADR 0016). Plain HTML, no app chrome; React escapes every value.
 */
export function PrintableMatrixPage(): React.JSX.Element {
  const { activeProjectId, activeProject } = useProject();
  const [params] = useSearchParams();
  const uncoveredOnly = params.get('uncoveredOnly') === 'true';
  const matrix = useQuery({
    queryKey: ['matrix', activeProjectId, uncoveredOnly],
    queryFn: () => traceabilityApi.matrix(activeProjectId ?? '', uncoveredOnly),
    enabled: activeProjectId !== null,
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <main className="print-page">
      <PrintToolbar />
      <h1>Traceability matrix — {activeProject?.name}</h1>
      <p className="muted">Generated {new Date().toLocaleString()}</p>
      <DataState isPending={matrix.isPending} error={matrix.error}>
        {matrix.data !== undefined && (
          <>
            <p>
              {matrix.data.summary.covered} of {matrix.data.summary.requirements} requirements
              covered ({matrix.data.summary.coverage}%), {matrix.data.summary.verified} verified,{' '}
              {matrix.data.summary.openDefects} open defects.
            </p>
            <table className="print-table" aria-label="Traceability matrix">
              <thead>
                <tr>
                  <th scope="col">Requirement</th>
                  <th scope="col">Cases</th>
                  <th scope="col">Covered</th>
                  <th scope="col">Verified</th>
                  <th scope="col">Open defects</th>
                </tr>
              </thead>
              <tbody>
                {matrix.data.rows.map((row) => (
                  <tr key={row.requirementId}>
                    <td>
                      <strong>{row.key}</strong> {row.title}
                    </td>
                    <td>
                      {row.cases.length === 0
                        ? 'None'
                        : row.cases
                            .map((testCase) => `${testCase.key} (${humanize(testCase.lastStatus)})`)
                            .join(', ')}
                    </td>
                    <td>{row.covered ? 'Yes' : 'No'}</td>
                    <td>{row.verified ? 'Yes' : 'No'}</td>
                    <td>{row.defectIds.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </DataState>
    </main>
  );
}

export function PrintToolbar(): React.JSX.Element {
  return (
    <div className="print-toolbar">
      <button
        type="button"
        className="ui-button ui-button--primary ui-button--md"
        onClick={() => {
          window.print();
        }}
      >
        Print / Save as PDF
      </button>
    </div>
  );
}
