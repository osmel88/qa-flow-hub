import { Badge, Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { projectsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';

export function ProjectsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isPending, error: loadError } = useQuery({
    queryKey: ['projects-page'],
    queryFn: () => projectsApi.list(),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['projects-page'] });
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const create = useMutation({
    mutationFn: () => projectsApi.create({ name, key: key.toUpperCase() }),
    onSuccess: async () => {
      setName('');
      setKey('');
      setError(null);
      await invalidate();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the project.');
    },
  });

  const toggleArchive = useMutation({
    mutationFn: (project: { id: string; status: string }) =>
      project.status === 'archived'
        ? projectsApi.restore(project.id)
        : projectsApi.archive(project.id),
    onSuccess: invalidate,
  });

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project owns its own key sequence: WEB-R-1, WEB-C-1, WEB-D-1."
      />

      <section className="card" aria-labelledby="new-project">
        <h2 id="new-project">New project</h2>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <div className="grid-2">
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label="Key"
            hint="Two to ten uppercase letters. It prefixes every readable id and cannot change."
            value={key}
            onChange={(event) => {
              setKey(event.target.value.toUpperCase());
            }}
          />
        </div>
        <Button
          loading={create.isPending}
          disabled={name.trim() === '' || key.trim() === ''}
          onClick={() => {
            create.mutate();
          }}
        >
          Create project
        </Button>
      </section>

      <DataState
        isPending={isPending}
        error={loadError}
        isEmpty={(data?.data.length ?? 0) === 0}
        emptyMessage="No projects yet. Create the first one above."
      >
        <table className="table card">
          <caption className="visually-hidden">Projects in this organization</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((project) => (
              <tr key={project.id}>
                <td>
                  <code>{project.key}</code>
                </td>
                <td>{project.name}</td>
                <td>
                  <Badge tone={toneFor(project.status)}>{humanize(project.status)}</Badge>
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      toggleArchive.mutate(project);
                    }}
                  >
                    {project.status === 'archived' ? 'Restore' : 'Archive'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
