import { ENVIRONMENT_KINDS } from '@qa-flow-hub/shared';
import type { EnvironmentKind, EnvironmentView, UpdateEnvironmentInput } from '@qa-flow-hub/shared';
import { Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { environmentsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { DeploymentsOf } from './DeploymentsPage';
import { EnvironmentBadges } from './EnvironmentsPage';

function EditEnvironment({
  env,
  onSave,
  pending,
}: {
  env: EnvironmentView;
  onSave: (body: UpdateEnvironmentInput) => void;
  pending: boolean;
}): React.JSX.Element {
  const [name, setName] = useState(env.name);
  const [kind, setKind] = useState<EnvironmentKind>(env.kind);
  const [description, setDescription] = useState(env.description ?? '');
  const [url, setUrl] = useState(env.url ?? '');
  const [position, setPosition] = useState(String(env.position));
  const [isProtected, setProtected] = useState(env.protected);
  const [active, setActive] = useState(env.status === 'active');
  return (
    <form
      className="card"
      aria-label="Edit environment"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          name: name.trim(),
          kind,
          description: description.trim() === '' ? null : description.trim(),
          url: url.trim() === '' ? null : url.trim(),
          position: Number.parseInt(position, 10) || 0,
          protected: isProtected,
          status: active ? 'active' : 'inactive',
          version: env.version,
        });
      }}
    >
      <h2>Edit</h2>
      <TextField
        label="Name"
        value={name}
        required
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <SelectField
        label="Type"
        value={kind}
        options={ENVIRONMENT_KINDS.map((value) => ({ value, label: humanize(value) }))}
        onChange={(event) => {
          setKind(event.target.value as EnvironmentKind);
        }}
      />
      <TextField
        label="Description"
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />
      <TextField
        label="URL"
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
        }}
      />
      <TextField
        label="Order"
        type="number"
        min={0}
        max={999}
        value={position}
        onChange={(event) => {
          setPosition(event.target.value);
        }}
      />
      <label>
        <input
          type="checkbox"
          checked={isProtected}
          onChange={(event) => {
            setProtected(event.target.checked);
          }}
        />{' '}
        Protected (deploying needs work item management)
      </label>
      <label>
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => {
            setActive(event.target.checked);
          }}
        />{' '}
        Active (takes new deployments)
      </label>
      <Button type="submit" disabled={pending}>
        Save environment
      </Button>
    </form>
  );
}

/** One environment (S6-F1): details, what runs there, recent deployments, edit and archive. */
export function EnvironmentDetailPage(): React.JSX.Element {
  const { environmentId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const environment = useQuery({
    queryKey: ['environment', environmentId],
    queryFn: () => environmentsApi.get(environmentId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const { can } = useProjectPermissions(environment.data?.projectId ?? null);
  const manage = can('work_items.manage');
  const refresh = async () => {
    setError(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['environment'] }),
      queryClient.invalidateQueries({ queryKey: ['environments'] }),
    ]);
  };
  const onError = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Could not update the environment.');
  };
  const update = useMutation({
    mutationFn: (body: UpdateEnvironmentInput) => environmentsApi.update(environmentId, body),
    onSuccess: refresh,
    onError,
  });
  const archive = useMutation({
    mutationFn: () => environmentsApi.archive(environmentId, environment.data?.version),
    onSuccess: refresh,
    onError,
  });
  const restore = useMutation({
    mutationFn: () => environmentsApi.restore(environmentId, environment.data?.version),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: () => environmentsApi.remove(environmentId),
    onSuccess: async () => {
      await refresh();
      void navigate('/environments');
    },
    onError,
  });
  const env = environment.data;

  return (
    <DataState isPending={environment.isPending} error={environment.error} isEmpty={false}>
      {env !== undefined && (
        <>
          <PageHeader
            title={`Environment ${env.name}`}
            description={env.description ?? `${humanize(env.kind)} environment.`}
          />
          <p>
            <Link to="/environments">← All environments</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="environment-summary">
            <h2 id="environment-summary">Summary</h2>
            <p>
              <EnvironmentBadges env={env} />{' '}
              <span className="muted" data-testid="environment-status">
                {humanize(env.status)}
              </span>
            </p>
            <ul aria-label="Environment facts">
              <li>Type: {humanize(env.kind)}</li>
              <li>Order: {env.position}</li>
              {env.url !== null && (
                <li>
                  URL:{' '}
                  <a href={env.url} target="_blank" rel="noreferrer">
                    {env.url}
                  </a>
                </li>
              )}
              <li data-testid="environment-current">
                Running:{' '}
                {env.current === null ? (
                  'nothing deployed'
                ) : (
                  <>
                    <Link to={`/deployments/${env.current.deploymentId}`}>
                      {env.current.identifier}
                    </Link>
                    {env.current.buildId !== null && (
                      <>
                        {' '}
                        · build{' '}
                        <Link to={`/builds/${env.current.buildId}`}>
                          {env.current.buildIdentifier}
                        </Link>
                      </>
                    )}
                    {env.current.release !== null && (
                      <>
                        {' '}
                        · release{' '}
                        <Link to={`/releases/${env.current.release.id}`}>
                          {env.current.release.version}
                        </Link>
                      </>
                    )}
                  </>
                )}
              </li>
              <li>
                Last deployment:{' '}
                {env.lastDeployment === null ? (
                  'none'
                ) : (
                  <Link to={`/deployments/${env.lastDeployment.id}`}>
                    {env.lastDeployment.identifier} ({humanize(env.lastDeployment.status)})
                  </Link>
                )}
              </li>
              <li>Deployments: {env.deploymentCount}</li>
            </ul>
            {env.metadata !== null && (
              <dl aria-label="Environment metadata">
                {Object.entries(env.metadata).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {manage && (
              <p>
                {env.status === 'archived' ? (
                  <Button
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() => {
                      restore.mutate();
                    }}
                  >
                    Restore environment
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={archive.isPending}
                    onClick={() => {
                      archive.mutate();
                    }}
                  >
                    Archive environment
                  </Button>
                )}{' '}
                {env.deploymentCount === 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate();
                    }}
                  >
                    Delete environment
                  </Button>
                )}
              </p>
            )}
          </section>
          {manage && env.status !== 'archived' && (
            <EditEnvironment
              key={env.version}
              env={env}
              pending={update.isPending}
              onSave={(body) => {
                update.mutate(body);
              }}
            />
          )}
          <DeploymentsOf projectId={env.projectId} filter={{ environmentId: env.id }} />
        </>
      )}
    </DataState>
  );
}
