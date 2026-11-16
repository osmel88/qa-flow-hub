import { DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { traceabilityApi } from '../api/endpoints';
import { humanize } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

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
      <h1>
        {t('printableMatrix.traceabilityMatrix')} {activeProject?.name}
      </h1>
      <p className="muted">
        {t('printableMatrix.generated')} {new Date().toLocaleString()}
      </p>
      <DataState isPending={matrix.isPending} error={matrix.error}>
        {matrix.data !== undefined && (
          <>
            <p>
              {matrix.data.summary.covered} {t('printableMatrix.of')}{' '}
              {matrix.data.summary.requirements} {t('printableMatrix.requirementsCovered')}
              {matrix.data.summary.coverage}%), {matrix.data.summary.verified}{' '}
              {t('printableMatrix.verified')} {matrix.data.summary.openDefects}{' '}
              {t('printableMatrix.openDefects')}
            </p>
            <table className="print-table" aria-label={t('printableMatrix.traceabilityMatrix2')}>
              <thead>
                <tr>
                  <th scope="col">{t('printableMatrix.requirement')}</th>
                  <th scope="col">{t('printableMatrix.cases')}</th>
                  <th scope="col">{t('printableMatrix.covered')}</th>
                  <th scope="col">{t('printableMatrix.verified2')}</th>
                  <th scope="col">{t('printableMatrix.openDefects2')}</th>
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
                        ? t('printableMatrix.none')
                        : row.cases
                            .map((testCase) => `${testCase.key} (${humanize(testCase.lastStatus)})`)
                            .join(', ')}
                    </td>
                    <td>{row.covered ? t('printableMatrix.yes') : t('printableMatrix.no')}</td>
                    <td>{row.verified ? t('printableMatrix.yes') : t('printableMatrix.no')}</td>
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
        {t('printableMatrix.printSaveAsPdf')}
      </button>
    </div>
  );
}
