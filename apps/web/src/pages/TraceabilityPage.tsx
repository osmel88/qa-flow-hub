import { Badge, DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { traceabilityApi } from '../api/endpoints';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

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
        title="Traceability"
        description="Every requirement, the cases that verify it, and the defects against it."
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
          Show only requirements with no test case
        </label>

        {matrix.data !== undefined && (
          <p>
            {matrix.data.summary.covered} of {matrix.data.summary.requirements} covered (
            {matrix.data.summary.coverage}%), {matrix.data.summary.verified} verified,{' '}
            {matrix.data.summary.openDefects} open defects.
          </p>
        )}
      </section>

      <DataState
        isPending={matrix.isPending}
        error={matrix.error}
        isEmpty={(matrix.data?.rows.length ?? 0) === 0}
        emptyMessage="Nothing to trace yet. Add requirements and link cases to them."
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Cases</th>
              <th scope="col">Covered</th>
              <th scope="col">Verified</th>
              <th scope="col">Defects</th>
            </tr>
          </thead>
          <tbody>
            {matrix.data?.rows.map((row) => (
              <tr key={row.requirementId}>
                <td>
                  <code>{row.key}</code> {row.title}
                </td>
                <td>
                  {row.cases.length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    <ul className="plain-list">
                      {row.cases.map((testCase) => (
                        <li key={testCase.id}>
                          <code>{testCase.key}</code>{' '}
                          <Badge tone={toneFor(testCase.lastStatus)}>
                            {humanize(testCase.lastStatus)}
                          </Badge>{' '}
                          {testCase.archived ? <Badge tone="neutral">Archived</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{row.covered ? 'Yes' : 'No'}</td>
                <td>{row.verified ? 'Yes' : 'No'}</td>
                <td>{row.defectIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
