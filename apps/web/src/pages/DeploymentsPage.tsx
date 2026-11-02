import { DEPLOYMENT_STATUSES, DEVELOPMENT_PROVIDERS } from '@qa-flow-hub/shared';
import type {
  DeploymentStatus,
  DeploymentView,
  DevelopmentProvider,
  ListDeploymentsQuery,
} from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  buildsApi,
  deploymentsApi,
  environmentsApi,
  releasesApi,
  workItemsApi,
} from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { formatDuration } from './BuildsPage';
import { NoProject } from './NoProject';

export const DEPLOYMENT_TONE: Record<DeploymentStatus, BadgeTone> = {
  pending: 'neutral',
  deploying: 'info',
  succeeded: 'success',
  failed: 'danger',
  rolled_back: 'warning',
  cancelled: 'neutral',
};

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

export function DeploymentList({
  deployments,
  label,
}: {
  deployments: readonly DeploymentView[];
  label: string;
}): React.JSX.Element {
  return (
    <table className="table" aria-label={label}>
      <thead>
        <tr>
          <th>Deployment</th>
          <th>Status</th>
          <th>Environment</th>
          <th>Build</th>
          <th>Release</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {deployments.map((deployment) => (
          <tr key={deployment.id} data-testid={`deployment-${deployment.identifier ?? ''}`}>
            <td>
              <Link to={`/deployments/${deployment.id}`}>{deployment.identifier}</Link>{' '}
              <span className="muted">{deployment.provider}</span>
            </td>
            <td>
              <Badge tone={DEPLOYMENT_TONE[(deployment.status ?? 'pending') as DeploymentStatus]}>
                {humanize(deployment.status ?? 'pending')}
              </Badge>
            </td>
            <td>{deployment.environmentRef?.name ?? deployment.environment ?? '—'}</td>
            <td>
              {deployment.build === null ? (
                <span className="muted">none</span>
              ) : (
                <Link to={`/builds/${deployment.build.id}`}>{deployment.build.identifier}</Link>
              )}
            </td>
            <td>
              {deployment.release === null ? (
                <span className="muted">none</span>
              ) : (
                <Link to={`/releases/${deployment.release.id}`}>{deployment.release.version}</Link>
              )}
            </td>
            <td>{formatDuration(deployment.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Deployments of a build, release or work item (S5-F5). */
export function DeploymentsOf({
  projectId,
  filter,
}: {
  projectId: string;
  filter: Pick<
    Partial<ListDeploymentsQuery>,
    'buildId' | 'releaseId' | 'workItemId' | 'environmentId'
  >;
}): React.JSX.Element {
  const deployments = useQuery({
    queryKey: ['deployments', projectId, 'of', filter],
    queryFn: () => deploymentsApi.list({ projectId, ...filter }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  return (
    <section className="card" aria-labelledby="deployments-of">
      <h2 id="deployments-of">Deployments</h2>
      {(deployments.data?.data.length ?? 0) === 0 ? (
        <p>No deployment yet.</p>
      ) : (
        <DeploymentList deployments={deployments.data?.data ?? []} label="Related deployments" />
      )}
    </section>
  );
}

/** Deployments of the project (S5-F5): environments, metrics, filters and a report form. */
export function DeploymentsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = useProjectPermissions(activeProjectId);
  const writable = can('work_items.write');
  const projectId = activeProjectId ?? '';
  const [filters, setFilters] = useState({
    status: '',
    environmentId: '',
    releaseId: '',
    buildId: '',
    provider: '',
  });
  const [identifier, setIdentifier] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [buildId, setBuildId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enabled = activeProjectId !== null;

  const deployments = useQuery({
    queryKey: ['deployments', activeProjectId, filters],
    queryFn: () =>
      deploymentsApi.list({
        projectId,
        ...(filters.status === '' ? {} : { status: filters.status as DeploymentStatus }),
        ...(filters.environmentId === '' ? {} : { environmentId: filters.environmentId }),
        ...(filters.releaseId === '' ? {} : { releaseId: filters.releaseId }),
        ...(filters.buildId === '' ? {} : { buildId: filters.buildId }),
        ...(filters.provider === '' ? {} : { provider: filters.provider as DevelopmentProvider }),
      }),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const metrics = useQuery({
    queryKey: ['deployments', activeProjectId, 'metrics'],
    queryFn: () => deploymentsApi.metrics(projectId),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const environments = useQuery({
    queryKey: ['environments', activeProjectId],
    queryFn: () => environmentsApi.list({ projectId }),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const builds = useQuery({
    queryKey: ['builds', activeProjectId, 'deployment-options'],
    queryFn: () => buildsApi.list({ projectId }),
    enabled,
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, 'build-options'],
    queryFn: () => releasesApi.list({ projectId }),
    enabled,
  });
  const workItems = useQuery({
    queryKey: ['work-items', activeProjectId, 'build-options'],
    queryFn: () => workItemsApi.list({ projectId }),
    enabled: enabled && writable,
  });
  const onError = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong.');
  };
  const create = useMutation({
    mutationFn: () =>
      deploymentsApi.create({
        projectId,
        identifier: identifier.trim(),
        environmentId,
        ...(buildId === '' ? {} : { buildId }),
        ...(releaseId === '' ? {} : { releaseId }),
        workItemIds: workItemId === '' ? [] : [workItemId],
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['deployments'] });
      await queryClient.invalidateQueries({ queryKey: ['development'] });
      void navigate(`/deployments/${result.deployment.id}`);
    },
    onError,
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  const envOptions = (environments.data ?? [])
    .filter((env) => env.status === 'active')
    .map((env) => ({
      value: env.id,
      label: env.protected ? `${env.name} (protected)` : env.name,
    }));
  const buildOptions = (builds.data?.data ?? []).map((build) => ({
    value: build.id,
    label: `${build.identifier ?? build.id} · ${build.status ?? ''}`,
  }));
  const releaseOptions = (releases.data?.data ?? []).map((release) => ({
    value: release.id,
    label: `${release.version} · ${release.name}`,
  }));
  const setFilter = (key: keyof typeof filters) => (event: { target: { value: string } }) => {
    setFilters((current) => ({ ...current, [key]: event.target.value }));
  };

  return (
    <>
      <PageHeader
        title="Deployments"
        description="Local deployments of builds to environments, with rollback."
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="card" aria-labelledby="environments">
        <h2 id="environments">Environments</h2>
        <ul aria-label="Environments">
          {(environments.data ?? []).map((env) => (
            <li key={env.id} data-testid={`environment-${env.name}`}>
              <Link to={`/environments/${env.id}`}>{env.name}</Link>{' '}
              <span className="muted">{env.kind}</span>{' '}
              {env.protected && <Badge tone="warning">protected</Badge>} ·{' '}
              {env.current === null ? (
                'nothing deployed'
              ) : (
                <Link to={`/deployments/${env.current.deploymentId}`}>
                  {env.current.identifier}
                </Link>
              )}
            </li>
          ))}
        </ul>
        <p>
          <Link to="/environments">Manage environments</Link>
        </p>
      </section>
      {metrics.data !== undefined && (
        <section className="card" aria-labelledby="deployment-metrics">
          <h2 id="deployment-metrics">Last {metrics.data.windowDays} days</h2>
          <dl className="kpis">
            <div>
              <dt>Deployments</dt>
              <dd data-testid="deployment-metric-total">{metrics.data.total}</dd>
            </div>
            <div>
              <dt>Success rate</dt>
              <dd data-testid="deployment-metric-success">{percent(metrics.data.successRate)}</dd>
            </div>
            <div>
              <dt>Failure rate</dt>
              <dd>{percent(metrics.data.failureRate)}</dd>
            </div>
            <div>
              <dt>Rollbacks</dt>
              <dd data-testid="deployment-metric-rollbacks">{metrics.data.rollbacks}</dd>
            </div>
            <div>
              <dt>Median duration</dt>
              <dd>{formatDuration(metrics.data.durationMs.median)}</dd>
            </div>
          </dl>
        </section>
      )}
      <section className="card filters" aria-label="Deployment filters">
        <SelectField
          label="Status filter"
          value={filters.status}
          options={[
            { value: '', label: 'Any status' },
            ...DEPLOYMENT_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={setFilter('status')}
        />
        <SelectField
          label="Environment filter"
          value={filters.environmentId}
          options={[{ value: '', label: 'Any environment' }, ...envOptions]}
          onChange={setFilter('environmentId')}
        />
        <SelectField
          label="Release filter"
          value={filters.releaseId}
          options={[{ value: '', label: 'Any release' }, ...releaseOptions]}
          onChange={setFilter('releaseId')}
        />
        <SelectField
          label="Build filter"
          value={filters.buildId}
          options={[{ value: '', label: 'Any build' }, ...buildOptions]}
          onChange={setFilter('buildId')}
        />
        <SelectField
          label="Provider filter"
          value={filters.provider}
          options={[
            { value: '', label: 'Any provider' },
            ...DEVELOPMENT_PROVIDERS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={setFilter('provider')}
        />
      </section>
      {writable && envOptions.length > 0 && (
        <form
          className="card"
          aria-label="Report a deployment"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <h2>Report a deployment</h2>
          <TextField
            label="Deployment identifier"
            value={identifier}
            required
            onChange={(event) => {
              setIdentifier(event.target.value);
            }}
          />
          <SelectField
            label="Target environment"
            value={environmentId}
            options={[{ value: '', label: 'Choose an environment' }, ...envOptions]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <SelectField
            label="Deployed build"
            value={buildId}
            options={[{ value: '', label: 'No build' }, ...buildOptions]}
            onChange={(event) => {
              setBuildId(event.target.value);
            }}
          />
          <SelectField
            label="Deployment release"
            value={releaseId}
            options={[{ value: '', label: 'No release' }, ...releaseOptions]}
            onChange={(event) => {
              setReleaseId(event.target.value);
            }}
          />
          <SelectField
            label="Deployed work item"
            value={workItemId}
            options={[
              { value: '', label: 'No work item' },
              ...(workItems.data?.data ?? []).map((item) => ({
                value: item.id,
                label: `${item.key} · ${item.title}`,
              })),
            ]}
            onChange={(event) => {
              setWorkItemId(event.target.value);
            }}
          />
          <Button type="submit" disabled={create.isPending || environmentId === ''}>
            Report deployment
          </Button>
        </form>
      )}
      <DataState
        isPending={deployments.isPending}
        error={deployments.error}
        isEmpty={(deployments.data?.data.length ?? 0) === 0}
        emptyMessage="No deployments match."
      >
        <section className="card">
          <DeploymentList deployments={deployments.data?.data ?? []} label="Deployments" />
        </section>
      </DataState>
    </>
  );
}
