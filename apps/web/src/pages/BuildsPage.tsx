import { BUILD_STATUSES, BUILD_TRIGGERS, DEVELOPMENT_PROVIDERS } from '@qa-flow-hub/shared';
import type { BuildStatus, BuildView, DevelopmentProvider } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { buildsApi, releasesApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export const BUILD_TONE: Record<BuildStatus, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  passed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

export function BuildList({
  builds,
  label,
}: {
  builds: readonly BuildView[];
  label: string;
}): React.JSX.Element {
  return (
    <table className="table" aria-label={label}>
      <thead>
        <tr>
          <th>Build</th>
          <th>Status</th>
          <th>Branch</th>
          <th>Duration</th>
          <th>Release</th>
          <th>Work items</th>
        </tr>
      </thead>
      <tbody>
        {builds.map((build) => (
          <tr key={build.id} data-testid={`build-${build.identifier ?? ''}`}>
            <td>
              <Link to={`/builds/${build.id}`}>{build.identifier}</Link>{' '}
              <span className="muted">{build.provider}</span>
            </td>
            <td>
              <Badge tone={BUILD_TONE[(build.status ?? 'queued') as BuildStatus]}>
                {humanize(build.status ?? 'queued')}
              </Badge>
            </td>
            <td>{build.branchName ?? <span className="muted">none</span>}</td>
            <td>{formatDuration(build.durationMs)}</td>
            <td>
              {build.release === null ? (
                <span className="muted">none</span>
              ) : (
                <Link to={`/releases/${build.release.id}`}>{build.release.version}</Link>
              )}
            </td>
            <td>
              {build.workItems.map((item) => (
                <Link key={item.workItemId} to={`/work-items/${item.workItemId}`}>
                  {item.key}{' '}
                </Link>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Builds of the project (S5-F4): metrics, filters and a form to report one. */
export function BuildsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = useProjectPermissions(activeProjectId);
  const writable = can('work_items.write');
  const projectId = activeProjectId ?? '';
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const [branch, setBranch] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [newStatus, setNewStatus] = useState<BuildStatus>('queued');
  const [trigger, setTrigger] = useState('manual');
  const [newRelease, setNewRelease] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmedBranch = branch.trim();

  const builds = useQuery({
    queryKey: ['builds', activeProjectId, status, provider, trimmedBranch, releaseId],
    queryFn: () =>
      buildsApi.list({
        projectId,
        ...(status === '' ? {} : { status: status as BuildStatus }),
        ...(provider === '' ? {} : { provider: provider as DevelopmentProvider }),
        ...(trimmedBranch === '' ? {} : { branch: trimmedBranch }),
        ...(releaseId === '' ? {} : { releaseId }),
      }),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const metrics = useQuery({
    queryKey: ['builds', activeProjectId, 'metrics'],
    queryFn: () => buildsApi.metrics(projectId),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, 'build-options'],
    queryFn: () => releasesApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });
  const workItems = useQuery({
    queryKey: ['work-items', activeProjectId, 'build-options'],
    queryFn: () => workItemsApi.list({ projectId }),
    enabled: activeProjectId !== null && writable,
  });
  const create = useMutation({
    mutationFn: () =>
      buildsApi.create({
        projectId,
        identifier: identifier.trim(),
        status: newStatus,
        trigger: trigger as (typeof BUILD_TRIGGERS)[number],
        ...(newBranch.trim() === '' ? {} : { branchName: newBranch.trim() }),
        ...(newRelease === '' ? {} : { releaseId: newRelease }),
        workItemIds: workItemId === '' ? [] : [workItemId],
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['builds'] });
      await queryClient.invalidateQueries({ queryKey: ['development'] });
      void navigate(`/builds/${result.build.id}`);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not report the build.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  const releaseOptions = (releases.data?.data ?? []).map((release) => ({
    value: release.id,
    label: `${release.version} · ${release.name}`,
  }));

  return (
    <>
      <PageHeader
        title="Builds"
        description="Local CI builds: status, duration, release and the work items they built."
      />
      {metrics.data !== undefined && (
        <section className="card" aria-labelledby="build-metrics">
          <h2 id="build-metrics">Last {metrics.data.windowDays} days</h2>
          <dl className="kpis">
            <div>
              <dt>Builds</dt>
              <dd data-testid="build-metric-total">{metrics.data.total}</dd>
            </div>
            <div>
              <dt>Success rate</dt>
              <dd data-testid="build-metric-success">{percent(metrics.data.successRate)}</dd>
            </div>
            <div>
              <dt>Failure rate</dt>
              <dd>{percent(metrics.data.failureRate)}</dd>
            </div>
            <div>
              <dt>Median duration</dt>
              <dd>{formatDuration(metrics.data.durationMs.median)}</dd>
            </div>
            <div>
              <dt>P85 duration</dt>
              <dd>{formatDuration(metrics.data.durationMs.p85)}</dd>
            </div>
          </dl>
        </section>
      )}
      <section className="card filters" aria-label="Build filters">
        <SelectField
          label="Status filter"
          value={status}
          options={[
            { value: '', label: 'Any status' },
            ...BUILD_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
        <SelectField
          label="Provider filter"
          value={provider}
          options={[
            { value: '', label: 'Any provider' },
            ...DEVELOPMENT_PROVIDERS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setProvider(event.target.value);
          }}
        />
        <TextField
          label="Branch filter"
          value={branch}
          onChange={(event) => {
            setBranch(event.target.value);
          }}
        />
        <SelectField
          label="Release filter"
          value={releaseId}
          options={[
            { value: '', label: 'Any release' },
            { value: 'none', label: 'No release' },
            ...releaseOptions,
          ]}
          onChange={(event) => {
            setReleaseId(event.target.value);
          }}
        />
      </section>
      {writable && (
        <form
          className="card"
          aria-label="Report a build"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <h2>Report a build</h2>
          <TextField
            label="Build identifier"
            value={identifier}
            required
            onChange={(event) => {
              setIdentifier(event.target.value);
            }}
          />
          <TextField
            label="Build branch"
            value={newBranch}
            onChange={(event) => {
              setNewBranch(event.target.value);
            }}
          />
          <SelectField
            label="Initial status"
            value={newStatus}
            options={BUILD_STATUSES.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              setNewStatus(event.target.value as BuildStatus);
            }}
          />
          <SelectField
            label="Trigger"
            value={trigger}
            options={BUILD_TRIGGERS.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              setTrigger(event.target.value);
            }}
          />
          <SelectField
            label="Build release"
            value={newRelease}
            options={[{ value: '', label: 'No release' }, ...releaseOptions]}
            onChange={(event) => {
              setNewRelease(event.target.value);
            }}
          />
          <SelectField
            label="Built work item"
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
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={create.isPending}>
            Report build
          </Button>
        </form>
      )}
      <DataState
        isPending={builds.isPending}
        error={builds.error}
        isEmpty={(builds.data?.data.length ?? 0) === 0}
        emptyMessage="No builds match."
      >
        <section className="card">
          <BuildList builds={builds.data?.data ?? []} label="Builds" />
        </section>
      </DataState>
    </>
  );
}
