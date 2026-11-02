import { DEPLOYMENT_TRANSITIONS } from '@qa-flow-hub/shared';
import type { DeploymentStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deploymentsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { formatDuration } from './BuildsPage';
import { DEPLOYMENT_TONE } from './DeploymentsPage';

/** A deployment: lifecycle, build, release, environment, work items and rollback (S5-F5). */
export function DeploymentDetailPage(): React.JSX.Element {
  const { deploymentId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const deployment = useQuery({
    queryKey: ['deployment', deploymentId],
    queryFn: () => deploymentsApi.get(deploymentId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const { can } = useProjectPermissions(deployment.data?.projectId ?? null);
  const writable = can('work_items.write');
  const refresh = async () => {
    setError(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['deployment'] }),
      queryClient.invalidateQueries({ queryKey: ['deployments'] }),
      queryClient.invalidateQueries({ queryKey: ['development'] }),
    ]);
  };
  const onError = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Could not update the deployment.');
  };
  const transition = useMutation({
    mutationFn: (status: 'deploying' | 'succeeded' | 'failed' | 'cancelled') =>
      deploymentsApi.transition(deploymentId, {
        status,
        ...(deployment.data === undefined ? {} : { version: deployment.data.version }),
      }),
    onSuccess: refresh,
    onError,
  });
  const rollback = useMutation({
    mutationFn: () =>
      deploymentsApi.rollback(deploymentId, {
        ...(deployment.data === undefined ? {} : { version: deployment.data.version }),
      }),
    onSuccess: async (created) => {
      await refresh();
      void navigate(`/deployments/${created.id}`);
    },
    onError,
  });

  const data = deployment.data;
  const status = (data?.status ?? 'pending') as DeploymentStatus;

  return (
    <DataState isPending={deployment.isPending} error={deployment.error} isEmpty={false}>
      {data !== undefined && (
        <>
          <PageHeader
            title={`Deployment ${data.identifier ?? ''}`}
            description={`To ${data.environmentRef?.name ?? data.environment ?? 'an environment'}.`}
          />
          <p>
            <Link to="/deployments">← All deployments</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="deployment-summary">
            <h2 id="deployment-summary">Summary</h2>
            <p>
              <span data-testid="deployment-status">
                <Badge tone={DEPLOYMENT_TONE[status]}>{humanize(status)}</Badge>
              </span>{' '}
              <span className="muted">
                {data.provider}
                {data.trigger !== null && ` · ${humanize(data.trigger)}`}
                {data.actor !== null && ` · by ${data.actor.fullName}`}
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
                <dd>{formatDuration(data.durationMs)}</dd>
              </div>
            </dl>
            <ul aria-label="Deployment references">
              <li>
                Build:{' '}
                {data.build === null ? (
                  'none'
                ) : (
                  <Link to={`/builds/${data.build.id}`}>{data.build.identifier}</Link>
                )}
                {data.commitSha !== null && (
                  <>
                    {' '}
                    · <code>{data.commitSha.slice(0, 7)}</code>
                  </>
                )}
              </li>
              <li>
                Release:{' '}
                {data.release === null ? (
                  'none'
                ) : (
                  <Link to={`/releases/${data.release.id}`}>
                    {data.release.version} · {data.release.name}
                  </Link>
                )}
              </li>
              {data.rollbackOf !== null && (
                <li>
                  Rollback of{' '}
                  <Link to={`/deployments/${data.rollbackOf.id}`}>
                    {data.rollbackOf.identifier}
                  </Link>
                </li>
              )}
              {data.rolledBackBy !== null && (
                <li>
                  Rolled back by{' '}
                  <Link to={`/deployments/${data.rolledBackBy.id}`}>
                    {data.rolledBackBy.identifier}
                  </Link>
                </li>
              )}
            </ul>
            {writable && (
              <p>
                {DEPLOYMENT_TRANSITIONS[status]
                  .filter((next) => next !== 'pending' && next !== 'rolled_back')
                  .map((next) => (
                    <Button
                      key={next}
                      size="sm"
                      variant={next === 'succeeded' ? 'primary' : 'secondary'}
                      disabled={transition.isPending}
                      onClick={() => {
                        transition.mutate(next);
                      }}
                    >
                      Mark {humanize(next)}
                    </Button>
                  ))}
                {status === 'succeeded' && data.rolledBackBy === null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={rollback.isPending}
                    onClick={() => {
                      rollback.mutate();
                    }}
                  >
                    Roll back
                  </Button>
                )}
              </p>
            )}
          </section>
          <section className="card" aria-labelledby="deployment-work-items">
            <h2 id="deployment-work-items">Work items</h2>
            {data.workItems.length === 0 ? (
              <p>No work item.</p>
            ) : (
              <ul aria-label="Deployed work items">
                {data.workItems.map((item) => (
                  <li key={item.workItemId}>
                    <Link to={`/work-items/${item.workItemId}`}>
                      {item.key} · {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.logSummary !== null && (
            <section className="card" aria-labelledby="deployment-log">
              <h2 id="deployment-log">Log</h2>
              <pre className="log">{data.logSummary}</pre>
            </section>
          )}
        </>
      )}
    </DataState>
  );
}
