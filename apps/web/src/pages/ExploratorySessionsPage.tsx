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
    return 'not started';
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
      setError(cause instanceof ApiError ? cause.message : 'Could not create the session.');
    },
  });
  if (activeProjectId === null) {
    return <NoProject />;
  }
  const rows = sessions.data?.data ?? [];
  return (
    <>
      <PageHeader
        title="Exploratory testing"
        description="Time-boxed sessions with a charter. Completed sessions are kept as immutable history."
      />
      {can('testruns.execute') && (
        <form
          className="card"
          aria-label="New exploratory session"
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
            label="Session title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <TextAreaField
            label="Charter"
            value={charter}
            onChange={(event) => {
              setCharter(event.target.value);
            }}
          />
          <SelectField
            label="Session environment"
            value={environmentId}
            options={[
              { value: '', label: 'No environment' },
              ...(environments.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <SelectField
            label="Session release"
            value={releaseId}
            options={[
              { value: '', label: 'No release' },
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
            label="Timebox (minutes)"
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
            Create session
          </Button>
        </form>
      )}
      <section className="card" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Sessions</h2>
        <SelectField
          label="Filter by status"
          value={status}
          options={[
            { value: '', label: 'All but archived' },
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
          emptyMessage="No session yet."
        >
          <table className="table" aria-label="Exploratory sessions">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col">Owner</th>
                <th scope="col">Environment</th>
                <th scope="col">Findings</th>
                <th scope="col">Duration</th>
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
                  <td>{row.owner?.fullName ?? 'nobody'}</td>
                  <td>{row.environment?.name ?? 'none'}</td>
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
