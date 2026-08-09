import { Badge, DataState } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/endpoints';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';

function Metric({ label, value }: { label: string; value: number | string }): React.JSX.Element {
  return (
    <div className="metric">
      <span className="metric__value">{value}</span>
      <span className="metric__label">{label}</span>
    </div>
  );
}

function Breakdown({
  title,
  counts,
}: {
  title: string;
  counts: Record<string, number>;
}): React.JSX.Element {
  const entries = Object.entries(counts);
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {entries.length === 0 ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <ul className="plain-list">
          {entries.map(([status, count]) => (
            <li key={status}>
              <Badge tone={toneFor(status)}>{humanize(status)}</Badge> {count}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { activeProject, activeProjectId } = useProject();
  const { data, isPending, error } = useQuery({
    queryKey: ['dashboard', activeProjectId],
    queryFn: () => dashboardApi.summary(activeProjectId ?? undefined),
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          activeProject === null
            ? 'Across every project in this organization.'
            : `Scoped to ${activeProject.key} — ${activeProject.name}.`
        }
      />

      <DataState isPending={isPending} error={error}>
        {data !== undefined && (
          <>
            <div className="metrics">
              <Metric label="Active projects" value={data.projects.active} />
              <Metric label="Requirements" value={data.requirements.total} />
              <Metric label="Test cases" value={data.testCases.total} />
              <Metric label="Runs in flight" value={data.runs.active} />
              <Metric label="Open defects" value={data.defects.open} />
              <Metric label="Coverage" value={`${data.coverage.percentage}%`} />
            </div>

            <section className="card" aria-labelledby="recent-runs">
              <h2 id="recent-runs">Recent runs</h2>
              {data.runs.recent.length === 0 ? (
                <p className="muted">No run has been created yet.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">Status</th>
                      <th scope="col">Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.recent.map((run) => (
                      <tr key={run.id}>
                        <td>{run.name}</td>
                        <td>
                          <Badge tone={toneFor(run.status)}>{humanize(run.status)}</Badge>
                        </td>
                        <td>
                          <progress max={100} value={run.completion} /> {run.completion}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <div className="grid-2">
              <Breakdown title="Results" counts={data.results} />
              <Breakdown title="Open defects by severity" counts={data.defects.bySeverity} />
              <Breakdown title="Requirements by status" counts={data.requirements.byStatus} />
              <Breakdown title="Test cases by status" counts={data.testCases.byStatus} />
            </div>
          </>
        )}
      </DataState>
    </>
  );
}
