import { EXPLORATORY_STATUSES } from '@qa-flow-hub/shared';
import type { ExploratoryStatus } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { environmentsApi, exploratoryApi, releasesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

export const EXPLORATORY_TONE: Record<ExploratoryStatus, BadgeTone> = {
  planned: 'neutral',
  active: 'info',
  paused: 'warning',
  completed: 'success',
  cancelled: 'warning',
  archived: 'neutral',
};

export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return t('exploratorySessions.notStarted');
  }
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

/** Exploratory sessions (S7-F5): charters, owners and their status. */
export function ExploratorySessionsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const projectId = activeProjectId ?? '';
  const [status, setStatus] = useState<ExploratoryStatus | ''>('');
  const [title, setTitle] = useState('');
  const [charter, setCharter] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [timebox, setTimebox] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enabled = activeProjectId !== null;
  const sessions = useQuery({
    queryKey: ['exploratory-sessions', activeProjectId, status],
    queryFn: () => exploratoryApi.list({ projectId, ...(status === '' ? {} : { status }) }),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const environments = useQuery({
    queryKey: ['environments', activeProjectId, 'exploratory-options'],
    queryFn: () => environmentsApi.list({ projectId }),
    enabled,
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, 'exploratory-options'],
    queryFn: () => releasesApi.list({ projectId }),
    enabled,
  });
  const create = useMutation({
    mutationFn: () =>
      exploratoryApi.create({
        projectId,
        title: title.trim(),
        charter: charter.trim(),
        ...(environmentId === '' ? {} : { environmentId }),
        ...(releaseId === '' ? {} : { releaseId }),
        ...(timebox === '' ? {} : { timeboxMinutes: Number(timebox) }),
      }),
    onSuccess: async () => {
      setTitle('');
      setCharter('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['exploratory-sessions'] });
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError
          ? cause.message
          : t('exploratorySessions.couldNotCreateTheSession'),
      );
    },
  });
  if (activeProjectId === null) {
    return <NoProject />;
  }
  const rows = sessions.data?.data ?? [];
  return (
    <>
      <PageHeader
        title={t('exploratorySessions.exploratoryTesting')}
        description={t('exploratorySessions.timeBoxedSessionsWithA')}
      />
      {can('testruns.execute') && (
        <form
          className="card"
          aria-label={t('exploratorySessions.newExploratorySession')}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <TextField
            label={t('exploratorySessions.sessionTitle')}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <TextAreaField
            label={t('exploratorySessions.charter')}
            value={charter}
            onChange={(event) => {
              setCharter(event.target.value);
            }}
          />
          <SelectField
            label={t('exploratorySessions.sessionEnvironment')}
            value={environmentId}
            options={[
              { value: '', label: t('exploratorySessions.noEnvironment') },
              ...(environments.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <SelectField
            label={t('exploratorySessions.sessionRelease')}
            value={releaseId}
            options={[
              { value: '', label: t('exploratorySessions.noRelease') },
              ...(releases.data?.data ?? []).map((entry) => ({
                value: entry.id,
                label: `${entry.version} · ${entry.name}`,
              })),
            ]}
            onChange={(event) => {
              setReleaseId(event.target.value);
            }}
          />
          <TextField
            label={t('exploratorySessions.timeboxMinutes')}
            type="number"
            value={timebox}
            onChange={(event) => {
              setTimebox(event.target.value);
            }}
          />
          <Button
            type="submit"
            loading={create.isPending}
            disabled={title.trim().length < 3 || charter.trim() === ''}
          >
            {t('exploratorySessions.createSession')}
          </Button>
        </form>
      )}
      <section className="card" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">{t('exploratorySessions.sessions')}</h2>
        <SelectField
          label={t('exploratorySessions.filterByStatus')}
          value={status}
          options={[
            { value: '', label: t('exploratorySessions.allButArchived') },
            ...EXPLORATORY_STATUSES.map((entry) => ({ value: entry, label: humanize(entry) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value as ExploratoryStatus | '');
          }}
        />
        <DataState
          isPending={sessions.isPending}
          error={sessions.error}
          isEmpty={rows.length === 0}
          emptyMessage={t('exploratorySessions.noSessionYet')}
        >
          <table className="table" aria-label={t('exploratorySessions.exploratorySessions')}>
            <thead>
              <tr>
                <th scope="col">{t('exploratorySessions.session')}</th>
                <th scope="col">{t('exploratorySessions.status')}</th>
                <th scope="col">{t('exploratorySessions.owner')}</th>
                <th scope="col">{t('exploratorySessions.environment')}</th>
                <th scope="col">{t('exploratorySessions.findings')}</th>
                <th scope="col">{t('exploratorySessions.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`session-${row.title}`}>
                  <td>
                    <Link to={`/exploratory-sessions/${row.id}`}>{row.title}</Link>
                  </td>
                  <td>
                    <Badge tone={EXPLORATORY_TONE[row.status]}>{humanize(row.status)}</Badge>
                  </td>
                  <td>{row.owner?.fullName ?? t('exploratorySessions.nobody')}</td>
                  <td>{row.environment?.name ?? t('exploratorySessions.none')}</td>
                  <td>{row.findingCount}</td>
                  <td>{formatDuration(row.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataState>
      </section>
    </>
  );
}
