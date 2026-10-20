import { Badge, Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { releasesApi, testDesignApi, testRunsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { GitHubRunCell, useGitHubReferences } from '../components/GitHubRunPanel';
import { TestRailSyncCell, useTestRailReferences } from '../components/TestRailSyncCell';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export function TestRunsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [releaseFilter, setReleaseFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['runs', activeProjectId, releaseFilter],
    queryFn: () =>
      testRunsApi.list({
        projectId: activeProjectId ?? '',
        ...(releaseFilter === '' ? {} : { releaseId: releaseFilter }),
      }),
    enabled: activeProjectId !== null,
  });

  const releases = useQuery({
    queryKey: ['releases', activeProjectId, ''],
    queryFn: () => releasesApi.list({ projectId: activeProjectId ?? '' }),
    enabled: activeProjectId !== null,
  });
  const releaseList = releases.data?.data ?? [];
  const openReleases = releaseList.filter(
    (release) => release.status === 'planned' || release.status === 'in_progress',
  );
  const releaseName = new Map(
    releaseList.map((release) => [release.id, `${release.name} (${release.version})`]),
  );

  const runReferences = useTestRailReferences(
    { entityType: 'test_run', projectId: activeProjectId ?? '' },
    activeProjectId !== null,
  );
  const gitHubReferences = useGitHubReferences(
    { entityType: 'test_run', projectId: activeProjectId ?? '' },
    activeProjectId !== null,
  );

  const suites = useQuery({
    queryKey: ['suites', activeProjectId],
    queryFn: () => testDesignApi.suites(activeProjectId ?? ''),
    enabled: activeProjectId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      testRunsApi.create({
        projectId: activeProjectId ?? '',
        name,
        // Selecting by suite rather than by id list keeps the run honest: it
        // takes whatever the suite holds at creation time and freezes a copy.
        selection: suiteId === '' ? {} : { suiteId },
        releaseId: releaseId === '' ? null : releaseId,
      }),
    onSuccess: async () => {
      setName('');
      setReleaseId('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the run.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title="Test runs"
        description="A run freezes the cases it contains, so editing a case later never rewrites history."
      />

      <section className="card" aria-labelledby="new-run">
        <h2 id="new-run">New run</h2>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <TextField
          label="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <label className="ui-field">
          <span className="ui-field__label">Cases from suite</span>
          <select
            className="ui-input"
            value={suiteId}
            onChange={(event) => {
              setSuiteId(event.target.value);
            }}
          >
            <option value="">Every case in the project</option>
            {suites.data?.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Release</span>
          <select
            className="ui-input"
            aria-label="Release"
            value={releaseId}
            onChange={(event) => {
              setReleaseId(event.target.value);
            }}
          >
            <option value="">No release</option>
            {openReleases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.name} ({release.version})
              </option>
            ))}
          </select>
        </label>
        <Button
          loading={create.isPending}
          disabled={name.trim() === ''}
          onClick={() => {
            create.mutate();
          }}
        >
          Create run
        </Button>
      </section>

      <label className="ui-field">
        <span className="ui-field__label">Filter by release</span>
        <select
          className="ui-input"
          aria-label="Filter by release"
          value={releaseFilter}
          onChange={(event) => {
            setReleaseFilter(event.target.value);
          }}
        >
          <option value="">All runs</option>
          {releaseList.map((release) => (
            <option key={release.id} value={release.id}>
              {release.name} ({release.version})
            </option>
          ))}
        </select>
      </label>

      <DataState
        isPending={runs.isPending}
        error={runs.error}
        isEmpty={(runs.data?.data.length ?? 0) === 0}
        emptyMessage="No run yet. Create one to start executing."
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Release</th>
              <th scope="col">Cases</th>
              <th scope="col">Progress</th>
              <th scope="col">TestRail</th>
              <th scope="col">GitHub</th>
            </tr>
          </thead>
          <tbody>
            {runs.data?.data.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link to={`/test-runs/${run.id}`}>{run.name}</Link>
                </td>
                <td>
                  <Badge tone={toneFor(run.status)}>{humanize(run.status)}</Badge>
                </td>
                <td>
                  {run.releaseId === null ? (
                    <span className="muted">No release</span>
                  ) : (
                    <Link to={`/releases/${run.releaseId}`}>
                      {releaseName.get(run.releaseId) ?? 'Release'}
                    </Link>
                  )}
                </td>
                <td>{run.progress.total}</td>
                <td>
                  <progress max={100} value={run.progress.completion} /> {run.progress.completion}%
                </td>
                <td>
                  <TestRailSyncCell
                    entityType="test_run"
                    entityId={run.id}
                    reference={runReferences.data?.get(run.id)}
                  />
                </td>
                <td>
                  <GitHubRunCell reference={gitHubReferences.data?.get(run.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
