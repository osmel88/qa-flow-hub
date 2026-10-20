import { RELEASE_STATUSES } from '@qa-flow-hub/shared';
import type { ReleaseStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, TextField } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { releasesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export const RELEASE_TONE: Record<ReleaseStatus, BadgeTone> = {
  planned: 'neutral',
  in_progress: 'info',
  released: 'success',
  archived: 'warning',
};

export function ReleasesPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [tag, setTag] = useState('');
  const [startDate, setStartDate] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [status, setStatus] = useState<ReleaseStatus | ''>('');
  const [error, setError] = useState<string | null>(null);

  const projectId = activeProjectId ?? '';

  const releases = useQuery({
    queryKey: ['releases', activeProjectId, status],
    queryFn: () => releasesApi.list({ projectId, ...(status === '' ? {} : { status }) }),
    enabled: activeProjectId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      releasesApi.create({
        projectId,
        name: name.trim(),
        version: version.trim(),
        tag: tag.trim() === '' ? null : tag.trim(),
        startDate: startDate === '' ? null : startDate,
        targetDate: targetDate === '' ? null : targetDate,
      }),
    onSuccess: async () => {
      setName('');
      setVersion('');
      setTag('');
      setStartDate('');
      setTargetDate('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the release.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title="Releases"
        description="A release groups the runs that decide whether a version can ship. Archiving one keeps every run and result."
      />

      {can('releases.manage') && (
        <section className="card" aria-labelledby="new-release">
          <h2 id="new-release">New release</h2>
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          <TextField
            label="Release name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label="Version"
            value={version}
            onChange={(event) => {
              setVersion(event.target.value);
            }}
          />
          <TextField
            label="Tag (optional)"
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
            }}
          />
          <TextField
            label="Start date"
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
          <TextField
            label="Target date"
            type="date"
            value={targetDate}
            onChange={(event) => {
              setTargetDate(event.target.value);
            }}
          />
          <Button
            loading={create.isPending}
            disabled={name.trim() === '' || version.trim() === ''}
            onClick={() => {
              create.mutate();
            }}
          >
            Create release
          </Button>
        </section>
      )}

      <label className="ui-field">
        <span className="ui-field__label">Status</span>
        <select
          className="ui-input"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as ReleaseStatus | '');
          }}
        >
          <option value="">Any status</option>
          {RELEASE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
        </select>
      </label>

      <DataState
        isPending={releases.isPending}
        error={releases.error}
        isEmpty={(releases.data?.data.length ?? 0) === 0}
        emptyMessage="No release yet."
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">Release</th>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Target date</th>
              <th scope="col">Runs</th>
            </tr>
          </thead>
          <tbody>
            {releases.data?.data.map((release) => (
              <tr key={release.id}>
                <td>
                  <Link to={`/releases/${release.id}`}>{release.name}</Link>
                </td>
                <td>
                  {release.version}
                  {release.tag !== null && <span className="muted"> ({release.tag})</span>}
                </td>
                <td>
                  <Badge tone={RELEASE_TONE[release.status]}>{humanize(release.status)}</Badge>
                </td>
                <td>{release.targetDate ?? '—'}</td>
                <td>{release.runCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
