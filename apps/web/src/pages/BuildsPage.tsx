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
import { t } from '../i18n/i18n';

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
          <th>{t('builds.build')}</th>
          <th>{t('builds.status')}</th>
          <th>{t('builds.branch')}</th>
          <th>{t('builds.duration')}</th>
          <th>{t('builds.release')}</th>
          <th>{t('builds.workItems')}</th>
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
            <td>{build.branchName ?? <span className="muted">{t('builds.none')}</span>}</td>
            <td>{formatDuration(build.durationMs)}</td>
            <td>
              {build.release === null ? (
                <span className="muted">{t('builds.none')}</span>
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
      setError(cause instanceof ApiError ? cause.message : t('builds.couldNotReportTheBuild'));
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
        title={t('builds.builds')}
        description={t('builds.localCiBuildsStatusDuration')}
      />
      {metrics.data !== undefined && (
        <section className="card" aria-labelledby="build-metrics">
          <h2 id="build-metrics">
            {t('builds.last')} {metrics.data.windowDays} {t('builds.days')}
          </h2>
          <dl className="kpis">
            <div>
              <dt>{t('builds.builds')}</dt>
              <dd data-testid="build-metric-total">{metrics.data.total}</dd>
            </div>
            <div>
              <dt>{t('builds.successRate')}</dt>
              <dd data-testid="build-metric-success">{percent(metrics.data.successRate)}</dd>
            </div>
            <div>
              <dt>{t('builds.failureRate')}</dt>
              <dd>{percent(metrics.data.failureRate)}</dd>
            </div>
            <div>
              <dt>{t('builds.medianDuration')}</dt>
              <dd>{formatDuration(metrics.data.durationMs.median)}</dd>
            </div>
            <div>
              <dt>{t('builds.p85Duration')}</dt>
              <dd>{formatDuration(metrics.data.durationMs.p85)}</dd>
            </div>
          </dl>
        </section>
      )}
      <section className="card filters" aria-label={t('builds.buildFilters')}>
        <SelectField
          label={t('builds.statusFilter')}
          value={status}
          options={[
            { value: '', label: t('builds.anyStatus') },
            ...BUILD_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('builds.providerFilter')}
          value={provider}
          options={[
            { value: '', label: t('builds.anyProvider') },
            ...DEVELOPMENT_PROVIDERS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setProvider(event.target.value);
          }}
        />
        <TextField
          label={t('builds.branchFilter')}
          value={branch}
          onChange={(event) => {
            setBranch(event.target.value);
          }}
        />
        <SelectField
          label={t('builds.releaseFilter')}
          value={releaseId}
          options={[
            { value: '', label: t('builds.anyRelease') },
            { value: 'none', label: t('builds.noRelease') },
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
          aria-label={t('builds.reportABuild')}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <h2>{t('builds.reportABuild')}</h2>
          <TextField
            label={t('builds.buildIdentifier')}
            value={identifier}
            required
            onChange={(event) => {
              setIdentifier(event.target.value);
            }}
          />
          <TextField
            label={t('builds.buildBranch')}
            value={newBranch}
            onChange={(event) => {
              setNewBranch(event.target.value);
            }}
          />
          <SelectField
            label={t('builds.initialStatus')}
            value={newStatus}
            options={BUILD_STATUSES.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              setNewStatus(event.target.value as BuildStatus);
            }}
          />
          <SelectField
            label={t('builds.trigger')}
            value={trigger}
            options={BUILD_TRIGGERS.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              setTrigger(event.target.value);
            }}
          />
          <SelectField
            label={t('builds.buildRelease')}
            value={newRelease}
            options={[{ value: '', label: t('builds.noRelease') }, ...releaseOptions]}
            onChange={(event) => {
              setNewRelease(event.target.value);
            }}
          />
          <SelectField
            label={t('builds.builtWorkItem')}
            value={workItemId}
            options={[
              { value: '', label: t('builds.noWorkItem') },
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
            {t('builds.reportBuild')}
          </Button>
        </form>
      )}
      <DataState
        isPending={builds.isPending}
        error={builds.error}
        isEmpty={(builds.data?.data.length ?? 0) === 0}
        emptyMessage={t('builds.noBuildsMatch')}
      >
        <section className="card">
          <BuildList builds={builds.data?.data ?? []} label={t('builds.builds')} />
        </section>
      </DataState>
    </>
  );
}
