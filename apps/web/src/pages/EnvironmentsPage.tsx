import { ENVIRONMENT_HEALTHS, ENVIRONMENT_KINDS, ENVIRONMENT_STATUSES } from '@qa-flow-hub/shared';
import type {
  EnvironmentHealth,
  EnvironmentKind,
  EnvironmentStatus,
  EnvironmentView,
} from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { environmentsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export const HEALTH_TONE: Record<EnvironmentHealth, BadgeTone> = {
  healthy: 'success',
  deploying: 'info',
  failing: 'danger',
  idle: 'neutral',
  inactive: 'neutral',
  archived: 'warning',
};

export function EnvironmentBadges({ env }: { env: EnvironmentView }): React.JSX.Element {
  return (
    <span data-testid={`environment-health-${env.name}`}>
      <Badge tone={HEALTH_TONE[env.health]}>{humanize(env.health)}</Badge>
      {env.protected && (
        <>
          {' '}
          <Badge tone="warning">protected</Badge>
        </>
      )}
    </span>
  );
}

/** Environments of the project (S6-F1): filters, health, what runs there, creation. */
export function EnvironmentsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = useProjectPermissions(activeProjectId);
  const manage = can('work_items.manage');
  const projectId = activeProjectId ?? '';
  const [filters, setFilters] = useState({ status: '', kind: '', health: '', search: '' });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EnvironmentKind>('staging');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const environments = useQuery({
    queryKey: ['environments', activeProjectId, filters],
    queryFn: () =>
      environmentsApi.list({
        projectId,
        ...(filters.status === '' ? {} : { status: filters.status as EnvironmentStatus }),
        ...(filters.kind === '' ? {} : { kind: filters.kind as EnvironmentKind }),
        ...(filters.health === '' ? {} : { health: filters.health as EnvironmentHealth }),
        ...(filters.search.trim() === '' ? {} : { search: filters.search.trim() }),
      }),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const create = useMutation({
    mutationFn: () =>
      environmentsApi.create({
        projectId,
        name: name.trim(),
        kind,
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(url.trim() === '' ? {} : { url: url.trim() }),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['environments'] });
      void navigate(`/environments/${created.id}`);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the environment.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  const setFilter = (key: keyof typeof filters) => (event: { target: { value: string } }) => {
    setFilters((current) => ({ ...current, [key]: event.target.value }));
  };

  return (
    <>
      <PageHeader
        title="Environments"
        description="Where the project is deployed, what runs there and how it is doing."
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="card filters" aria-label="Environment filters">
        <TextField
          label="Search environments"
          value={filters.search}
          onChange={setFilter('search')}
        />
        <SelectField
          label="Environment status"
          value={filters.status}
          options={[
            { value: '', label: 'Active and inactive' },
            ...ENVIRONMENT_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={setFilter('status')}
        />
        <SelectField
          label="Environment type"
          value={filters.kind}
          options={[
            { value: '', label: 'Any type' },
            ...ENVIRONMENT_KINDS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={setFilter('kind')}
        />
        <SelectField
          label="Environment health"
          value={filters.health}
          options={[
            { value: '', label: 'Any health' },
            ...ENVIRONMENT_HEALTHS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={setFilter('health')}
        />
      </section>
      {manage && (
        <form
          className="card"
          aria-label="Add an environment"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <h2>Add an environment</h2>
          <TextField
            label="Environment name"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <SelectField
            label="Environment kind"
            value={kind}
            options={ENVIRONMENT_KINDS.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              setKind(event.target.value as EnvironmentKind);
            }}
          />
          <TextField
            label="Environment description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <TextField
            label="Environment URL"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
          <p className="muted">Production environments start protected.</p>
          <Button type="submit" disabled={create.isPending}>
            Add environment
          </Button>
        </form>
      )}
      <DataState
        isPending={environments.isPending}
        error={environments.error}
        isEmpty={(environments.data?.length ?? 0) === 0}
        emptyMessage="No environments match."
      >
        <section className="card">
          <table className="table" aria-label="Environments">
            <thead>
              <tr>
                <th>Environment</th>
                <th>Health</th>
                <th>Running</th>
                <th>Release</th>
                <th>Deployments</th>
              </tr>
            </thead>
            <tbody>
              {(environments.data ?? []).map((env) => (
                <tr key={env.id} data-testid={`environment-row-${env.name}`}>
                  <td>
                    <Link to={`/environments/${env.id}`}>{env.name}</Link>{' '}
                    <span className="muted">
                      {humanize(env.kind)}
                      {env.status !== 'active' && ` · ${humanize(env.status)}`}
                    </span>
                  </td>
                  <td>
                    <EnvironmentBadges env={env} />
                  </td>
                  <td>
                    {env.current === null ? (
                      <span className="muted">nothing deployed</span>
                    ) : (
                      <Link to={`/deployments/${env.current.deploymentId}`}>
                        {env.current.identifier}
                      </Link>
                    )}
                  </td>
                  <td>{env.current?.release?.version ?? <span className="muted">none</span>}</td>
                  <td>{env.deploymentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </DataState>
    </>
  );
}
