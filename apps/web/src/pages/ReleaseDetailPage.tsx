import { RELEASE_TRANSITIONS } from '@qa-flow-hub/shared';
import type { ReleaseStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { releasesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { RELEASE_TONE } from './ReleasesPage';

const ACTIONS: Array<{
  to: ReleaseStatus;
  action: 'start' | 'release' | 'archive';
  label: string;
}> = [
  { to: 'in_progress', action: 'start', label: 'Start release' },
  { to: 'released', action: 'release', label: 'Mark as released' },
  { to: 'archived', action: 'archive', label: 'Archive release' },
];

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function ReleaseDetailPage(): React.JSX.Element {
  const { releaseId = '' } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['releases', 'summary', releaseId],
    queryFn: () => releasesApi.summary(releaseId),
  });
  const trace = useQuery({
    queryKey: ['releases', 'traceability', releaseId],
    queryFn: () => releasesApi.traceability(releaseId),
  });
  const release = summary.data?.release;
  const { can } = useProjectPermissions(release?.projectId ?? null);

  const transition = useMutation({
    mutationFn: (action: 'start' | 'release' | 'archive') =>
      releasesApi.transition(releaseId, action),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the release.');
    },
  });

  return (
    <DataState isPending={summary.isPending} error={summary.error} isEmpty={false}>
      {release !== undefined && summary.data !== undefined && (
        <>
          <PageHeader
            title={`${release.name} · ${release.version}`}
            description={release.description ?? 'Runs, results and coverage of this release.'}
          />
          <p>
            <Badge tone={RELEASE_TONE[release.status]}>{humanize(release.status)}</Badge>{' '}
            {release.tag !== null && <span>Tag {release.tag} · </span>}
            <span>
              {release.startDate ?? '—'} → {release.targetDate ?? '—'}
            </span>
          </p>
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          {can('releases.manage') && (
            <div className="actions">
              {ACTIONS.filter((item) => RELEASE_TRANSITIONS[release.status].includes(item.to)).map(
                (item) => (
                  <Button
                    key={item.action}
                    variant={item.action === 'archive' ? 'secondary' : 'primary'}
                    loading={transition.isPending && transition.variables === item.action}
                    onClick={() => {
                      transition.mutate(item.action);
                    }}
                  >
                    {item.label}
                  </Button>
                ),
              )}
            </div>
          )}

          <section className="card" aria-labelledby="release-kpis">
            <h2 id="release-kpis">Release health</h2>
            <dl className="kpis">
              <div>
                <dt>Cases</dt>
                <dd>{summary.data.cases.total}</dd>
              </div>
              <div>
                <dt>Pass rate</dt>
                <dd>{percent(summary.data.cases.passRate)}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>{summary.data.cases.failed}</dd>
              </div>
              <div>
                <dt>Requirements passing</dt>
                <dd>
                  {summary.data.requirements.passing} / {summary.data.requirements.total}
                </dd>
              </div>
              <div>
                <dt>Open defects</dt>
                <dd>{summary.data.defects.open}</dd>
              </div>
            </dl>
          </section>

          <section className="card" aria-labelledby="release-runs">
            <h2 id="release-runs">Runs</h2>
            {summary.data.runs.length === 0 ? (
              <p>No run in this release yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Status</th>
                    <th scope="col">Cases</th>
                    <th scope="col">Pass rate</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data.runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link to={`/test-runs/${run.id}`}>{run.name}</Link>
                      </td>
                      <td>
                        <Badge tone={toneFor(run.status)}>{humanize(run.status)}</Badge>
                      </td>
                      <td>{run.counts.total}</td>
                      <td>{percent(run.counts.passRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card" aria-labelledby="release-trace">
            <h2 id="release-trace">Traceability</h2>
            <DataState
              isPending={trace.isPending}
              error={trace.error}
              isEmpty={(trace.data?.rows.length ?? 0) === 0}
              emptyMessage="No requirement in this project yet."
            >
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Requirement</th>
                    <th scope="col">Cases and latest result in this release</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.data?.rows.map((row) => (
                    <tr key={row.requirementId}>
                      <td>
                        {row.key} · {row.title}
                      </td>
                      <td>
                        {row.cases.length === 0
                          ? 'No verifying case'
                          : row.cases.map((item) => (
                              <span key={item.testCaseId} className="trace-chip">
                                {item.key}{' '}
                                <Badge tone={toneFor(item.status)}>{humanize(item.status)}</Badge>
                                {item.testRunName !== null && <> in {item.testRunName}</>}{' '}
                              </span>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataState>
          </section>
        </>
      )}
    </DataState>
  );
}
