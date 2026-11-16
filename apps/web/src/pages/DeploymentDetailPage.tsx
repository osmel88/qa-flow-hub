import { DEPLOYMENT_TRANSITIONS } from '@qa-flow-hub/shared';
import type { DeploymentStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, TextField } from '@qa-flow-hub/ui';
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
import { t } from '../i18n/i18n';

/** A deployment: lifecycle, build, release, environment, work items and rollback (S5-F5). */
export function DeploymentDetailPage(): React.JSX.Element {
  const { deploymentId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
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
    setError(
      cause instanceof ApiError ? cause.message : t('deploymentDetail.couldNotUpdateTheDeployment'),
    );
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
        reason: reason.trim(),
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
            title={t('deploymentDetail.deployment', { value: data.identifier ?? '' })}
            description={t('deploymentDetail.to', {
              value: data.environmentRef?.name ?? data.environment ?? 'an environment',
            })}
          />
          <p>
            <Link to="/deployments">{t('deploymentDetail.allDeployments')}</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="deployment-summary">
            <h2 id="deployment-summary">{t('deploymentDetail.summary')}</h2>
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
                <dt>{t('deploymentDetail.started')}</dt>
                <dd>{data.startedAt === null ? '—' : new Date(data.startedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t('deploymentDetail.finished')}</dt>
                <dd>
                  {data.finishedAt === null ? '—' : new Date(data.finishedAt).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>{t('deploymentDetail.duration')}</dt>
                <dd>{formatDuration(data.durationMs)}</dd>
              </div>
            </dl>
            <ul aria-label={t('deploymentDetail.deploymentReferences')}>
              <li>
                {t('deploymentDetail.build')}{' '}
                {data.build === null ? (
                  t('deploymentDetail.none')
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
                {t('deploymentDetail.release')}{' '}
                {data.release === null ? (
                  t('deploymentDetail.none')
                ) : (
                  <Link to={`/releases/${data.release.id}`}>
                    {data.release.version} · {data.release.name}
                  </Link>
                )}
              </li>
              {data.rollbackOf !== null && (
                <li data-testid="deployment-rollback">
                  {t('deploymentDetail.rolledBackFrom')}{' '}
                  <Link to={`/deployments/${data.rollbackOf.id}`}>
                    {data.rollbackOf.identifier}
                  </Link>{' '}
                  {t('deploymentDetail.to2')}{' '}
                  {data.rollbackTarget === null ? (
                    t('deploymentDetail.anEarlierBuild')
                  ) : (
                    <Link to={`/deployments/${data.rollbackTarget.id}`}>
                      {data.rollbackTarget.identifier}
                    </Link>
                  )}
                  {data.rollbackEmergency && (
                    <>
                      {' '}
                      <Badge tone="danger">{t('deploymentDetail.emergency')}</Badge>
                    </>
                  )}
                </li>
              )}
              {data.rollbackReason !== null && (
                <li>
                  {t('deploymentDetail.rollbackReason')} {data.rollbackReason}
                </li>
              )}
              {data.rolledBackBy !== null && (
                <li>
                  {t('deploymentDetail.rolledBackBy')}{' '}
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
                      {t('deploymentDetail.mark')} {humanize(next)}
                    </Button>
                  ))}
                {status === 'succeeded' && data.rolledBackBy === null && (
                  <TextField
                    label={t('deploymentDetail.rollbackReason2')}
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                )}
                {status === 'succeeded' && data.rolledBackBy === null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={rollback.isPending || reason.trim().length < 10}
                    onClick={() => {
                      rollback.mutate();
                    }}
                  >
                    {t('deploymentDetail.rollBack')}
                  </Button>
                )}
              </p>
            )}
          </section>
          <section className="card" aria-labelledby="deployment-work-items">
            <h2 id="deployment-work-items">{t('deploymentDetail.workItems')}</h2>
            {data.workItems.length === 0 ? (
              <p>{t('deploymentDetail.noWorkItem')}</p>
            ) : (
              <ul aria-label={t('deploymentDetail.deployedWorkItems')}>
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
              <h2 id="deployment-log">{t('deploymentDetail.log')}</h2>
              <pre className="log">{data.logSummary}</pre>
            </section>
          )}
        </>
      )}
    </DataState>
  );
}
