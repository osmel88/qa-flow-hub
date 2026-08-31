import { Badge, Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { testDesignApi, testRunsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export function TestRunsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['runs', activeProjectId],
    queryFn: () => testRunsApi.list({ projectId: activeProjectId ?? '' }),
    enabled: activeProjectId !== null,
  });

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
      }),
    onSuccess: async () => {
      setName('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
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
              <th scope="col">Cases</th>
              <th scope="col">Progress</th>
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
                <td>{run.progress.total}</td>
                <td>
                  <progress max={100} value={run.progress.completion} /> {run.progress.completion}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
