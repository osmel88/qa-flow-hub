import { Badge, DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ImplementationBadge } from '../components/ImplementationBadge';
import { exportsApi, traceabilityApi } from '../api/endpoints';
import { ExportButton } from '../components/ExportButton';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

/**
 * The traceability matrix.
 *
 * Covered and verified are shown as separate columns on purpose. Covered only
 * says a case exists; verified says it ran, passed, and no open defect points
 * at the requirement. A report that shows one number invites writing empty
 * cases to make it green.
 */
export function TraceabilityPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const [uncoveredOnly, setUncoveredOnly] = useState(false);
  const { can } = useProjectPermissions(activeProjectId);

  const matrix = useQuery({
    queryKey: ['matrix', activeProjectId, uncoveredOnly],
    queryFn: () => traceabilityApi.matrix(activeProjectId ?? '', uncoveredOnly),
    enabled: activeProjectId !== null,
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title={t('traceability.traceability')}
        description={t('traceability.everyRequirementTheCasesThat')}
        actions={
          can('data.export') ? (
            <>
              <ExportButton
                label={t('traceability.exportCsv')}
                fallbackName="traceability-matrix.csv"
                download={() => exportsApi.matrix(activeProjectId, uncoveredOnly)}
              />
              <Link
                to={`/print/traceability?uncoveredOnly=${String(uncoveredOnly)}`}
                target="_blank"
                rel="noopener"
              >
                {t('traceability.printableView')}
              </Link>
            </>
          ) : undefined
        }
      />

      <section className="card">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={uncoveredOnly}
            onChange={(event) => {
              setUncoveredOnly(event.target.checked);
            }}
          />
          {t('traceability.showOnlyRequirementsWithNo')}
        </label>

        {matrix.data !== undefined && (
          <p>
            {matrix.data.summary.covered} {t('traceability.of')} {matrix.data.summary.requirements}{' '}
            {t('traceability.covered')}
            {matrix.data.summary.coverage}%), {matrix.data.summary.verified}{' '}
            {t('traceability.verified')} {matrix.data.summary.openDefects}{' '}
            {t('traceability.openDefects')}
          </p>
        )}
      </section>

      <DataState
        isPending={matrix.isPending}
        error={matrix.error}
        isEmpty={(matrix.data?.rows.length ?? 0) === 0}
        emptyMessage={t('traceability.nothingToTraceYetAdd')}
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">{t('traceability.requirement')}</th>
              <th scope="col">{t('traceability.workItems')}</th>
              <th scope="col">{t('traceability.cases')}</th>
              <th scope="col">{t('traceability.covered2')}</th>
              <th scope="col">{t('traceability.verified2')}</th>
              <th scope="col">{t('traceability.defects')}</th>
            </tr>
          </thead>
          <tbody>
            {matrix.data?.rows.map((row) => (
              <tr key={row.requirementId}>
                <td>
                  <Link to={`/requirements/${row.requirementId}`}>
                    <code>{row.key}</code> {row.title}
                  </Link>
                </td>
                <td>
                  <ImplementationBadge implementation={row.implementation} />
                  {row.workItems.map((item) => (
                    <div key={item.linkId}>
                      <Link to={`/work-items/${item.workItemId}`}>
                        <code>{item.key}</code>
                      </Link>{' '}
                      {humanize(item.status)}
                    </div>
                  ))}
                </td>
                <td>
                  {row.cases.length === 0 ? (
                    <span className="muted">{t('traceability.none')}</span>
                  ) : (
                    <ul className="plain-list">
                      {row.cases.map((testCase) => (
                        <li key={testCase.id}>
                          <code>{testCase.key}</code>{' '}
                          <Badge tone={toneFor(testCase.lastStatus)}>
                            {humanize(testCase.lastStatus)}
                          </Badge>{' '}
                          {testCase.lastExecutedVersion !== null && (
                            <span className="muted">v{testCase.lastExecutedVersion} </span>
                          )}
                          {testCase.archived ? (
                            <Badge tone="neutral">{t('traceability.archived')}</Badge>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{row.covered ? t('traceability.yes') : t('traceability.no')}</td>
                <td>{row.verified ? t('traceability.yes') : t('traceability.no')}</td>
                <td>{row.defectIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
