import { BUILD_TRANSITIONS } from '@qa-flow-hub/shared';
import type { BuildStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { buildsApi, developmentApi, releasesApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { BUILD_TONE, formatDuration } from './BuildsPage';
import { DeploymentsOf } from './DeploymentsPage';

/** A build: lifecycle, release, work items and related branch/commit (S5-F4). */
export function BuildDetailPage(): React.JSX.Element {
  const { buildId = '' } = useParams();
  const queryClient = useQueryClient();
  const [workItemId, setWorkItemId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const build = useQuery({
    queryKey: ['build', buildId],
    queryFn: () => buildsApi.get(buildId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const projectId = build.data?.projectId ?? null;
  const { can } = useProjectPermissions(projectId);
  const writable = can('work_items.write');
  const releases = useQuery({
    queryKey: ['releases', projectId, 'build-options'],
    queryFn: () => releasesApi.list({ projectId: projectId ?? '' }),
    enabled: writable && projectId !== null,
  });
  const workItems = useQuery({
    queryKey: ['work-items', projectId, 'build-options'],
    queryFn: () => workItemsApi.list({ projectId: projectId ?? '' }),
    enabled: writable && projectId !== null,
  });
  const act = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setError(null);
      setWorkItemId('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['build', buildId] }),
        queryClient.invalidateQueries({ queryKey: ['builds'] }),
        queryClient.invalidateQueries({ queryKey: ['development'] }),
      ]);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not update the build.');
    },
  });

  const data = build.data;
  const status = (data?.status ?? 'queued') as BuildStatus;

  return (
    <DataState isPending={build.isPending} error={build.error} isEmpty={false}>
      {data !== undefined && (
        <>
          <PageHeader title={`Build ${data.identifier ?? ''}`} description="Build detail." />
          <p>
            <Link to="/builds">← All builds</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="build-summary">
            <h2 id="build-summary">Summary</h2>
            <p>
              <span data-testid="build-status">
                <Badge tone={BUILD_TONE[status]}>{humanize(status)}</Badge>
              </span>{' '}
              <span className="muted">
                {data.provider}
                {data.trigger !== null && ` · ${humanize(data.trigger)}`}
              </span>
            </p>
            <dl className="kpis">
              <div>
                <dt>Started</dt>
                <dd>{data.startedAt === null ? '—' : new Date(data.startedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>
                  {data.finishedAt === null ? '—' : new Date(data.finishedAt).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd data-testid="build-duration">{formatDuration(data.durationMs)}</dd>
              </div>
            </dl>
            <p>
              Branch:{' '}
              {data.branchName === null ? (
                'none'
              ) : data.related.branchId === null ? (
                <code>{data.branchName}</code>
              ) : (
                <Link to="/development?kind=branch">
                  <code>{data.branchName}</code>
                </Link>
              )}{' '}
              · Commit:{' '}
              {data.commitSha === null ? 'none' : <code>{data.commitSha.slice(0, 7)}</code>}
              {data.url !== null && (
                <>
                  {' '}
                  ·{' '}
                  <a href={data.url} target="_blank" rel="noopener noreferrer">
                    Open in CI
                  </a>
                </>
              )}
            </p>
            {writable && BUILD_TRANSITIONS[status].length > 0 && (
              <p>
                {BUILD_TRANSITIONS[status].map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    variant={next === 'passed' ? 'primary' : 'secondary'}
                    onClick={() => {
                      act.mutate(() => buildsApi.transition(data.id, { status: next }));
                    }}
                  >
                    Mark {humanize(next)}
                  </Button>
                ))}
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="build-release">
            <h2 id="build-release">Release</h2>
            {writable ? (
              <SelectField
                label="Release of the build"
                value={data.release?.id ?? ''}
                options={[
                  { value: '', label: 'No release' },
                  ...(releases.data?.data ?? []).map((release) => ({
                    value: release.id,
                    label: `${release.version} · ${release.name}`,
                  })),
                ]}
                onChange={(event) => {
                  const value = event.target.value;
                  act.mutate(() =>
                    buildsApi.update(data.id, { releaseId: value === '' ? null : value }),
                  );
                }}
              />
            ) : data.release === null ? (
              <p>No release.</p>
            ) : null}
            {data.release !== null && (
              <p>
                <Link to={`/releases/${data.release.id}`}>
                  {data.release.version} · {data.release.name}
                </Link>
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="build-work-items">
            <h2 id="build-work-items">Work items</h2>
            <ul aria-label="Built work items">
              {data.workItems.map((item) => (
                <li key={item.workItemId}>
                  <Link to={`/work-items/${item.workItemId}`}>
                    {item.key} · {item.title}
                  </Link>{' '}
                  {writable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Unlink ${item.key}`}
                      onClick={() => {
                        act.mutate(() => developmentApi.unlink(item.workItemId, data.id));
                      }}
                    >
                      Unlink
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {writable && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (workItemId !== '') {
                    act.mutate(() => developmentApi.link(workItemId, data.id));
                  }
                }}
              >
                <SelectField
                  label="Link work item"
                  value={workItemId}
                  options={[
                    { value: '', label: 'Choose a work item' },
                    ...(workItems.data?.data ?? [])
                      .filter(
                        (item) => !data.workItems.some((linked) => linked.workItemId === item.id),
                      )
                      .map((item) => ({ value: item.id, label: `${item.key} · ${item.title}` })),
                  ]}
                  onChange={(event) => {
                    setWorkItemId(event.target.value);
                  }}
                />
                <Button type="submit" size="sm">
                  Link
                </Button>
              </form>
            )}
          </section>

          <DeploymentsOf projectId={data.projectId} filter={{ buildId: data.id }} />

          {(data.metadata !== null || data.logSummary !== null) && (
            <section className="card" aria-labelledby="build-output">
              <h2 id="build-output">Output</h2>
              {data.metadata !== null && data.metadata.artifacts.length > 0 && (
                <ul aria-label="Build artifacts">
                  {data.metadata.artifacts.map((artifact) => (
                    <li key={artifact.name}>
                      {artifact.url === undefined ? (
                        artifact.name
                      ) : (
                        <a href={artifact.url} target="_blank" rel="noopener noreferrer">
                          {artifact.name}
                        </a>
                      )}
                      {artifact.sizeBytes !== undefined && ` (${artifact.sizeBytes} bytes)`}
                    </li>
                  ))}
                </ul>
              )}
              {data.logSummary !== null && <pre className="log">{data.logSummary}</pre>}
            </section>
          )}
        </>
      )}
    </DataState>
  );
}
