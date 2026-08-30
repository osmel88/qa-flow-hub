import { REQUIREMENT_STATUSES, REQUIREMENT_TYPES, PRIORITIES } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { requirementsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { CoverageLinks } from '../components/CoverageLinks';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: humanize(value) }));

export function RequirementsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>('functional');
  const [priority, setPriority] = useState<string>('medium');
  const [error, setError] = useState<string | null>(null);
  // One requirement at a time: the panel is an editor, and two open at once
  // invites linking a case to the requirement the user was not looking at.
  const [coverageFor, setCoverageFor] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['requirements', activeProjectId, status, search],
    queryFn: () =>
      requirementsApi.list({
        projectId: activeProjectId ?? '',
        ...(status === '' ? {} : { status }),
        ...(search === '' ? {} : { search }),
      }),
    enabled: activeProjectId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      requirementsApi.create({
        projectId: activeProjectId ?? '',
        title,
        description: description === '' ? null : description,
        type: type as 'functional',
        priority: priority as 'medium',
        tags: [],
      }),
    onSuccess: async () => {
      setTitle('');
      setDescription('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the requirement.');
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      requirementsApi.changeStatus(input.id, input.status),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    },
    onError: (cause) => {
      // The API refuses illegal transitions; surfacing its message is more
      // useful than duplicating the state machine in the client.
      setError(cause instanceof ApiError ? cause.message : 'Could not change the status.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader title="Requirements" description="What the product must do, and its coverage." />

      <section className="card" aria-labelledby="new-requirement">
        <h2 id="new-requirement">New requirement</h2>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <TextField
          label="Title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <TextAreaField
          label="Description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        <div className="grid-2">
          <SelectField
            label="Type"
            options={options(REQUIREMENT_TYPES)}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
            }}
          />
          <SelectField
            label="Priority"
            options={options(PRIORITIES)}
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value);
            }}
          />
        </div>
        <Button
          loading={create.isPending}
          disabled={title.trim().length < 3}
          onClick={() => {
            create.mutate();
          }}
        >
          Create requirement
        </Button>
      </section>

      <section className="card filters" aria-label="Filters">
        <TextField
          label="Search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <SelectField
          label="Status"
          options={[{ value: '', label: 'Any status' }, ...options(REQUIREMENT_STATUSES)]}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
      </section>

      <DataState
        isPending={list.isPending}
        error={list.error}
        isEmpty={(list.data?.data.length ?? 0) === 0}
        emptyMessage="No requirement matches these filters."
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Title</th>
              <th scope="col">Priority</th>
              <th scope="col">Status</th>
              <th scope="col">Move to</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.data.map((requirement) => (
              <Fragment key={requirement.id}>
                <tr>
                  <td>
                    <code>{requirement.key}</code>
                  </td>
                  <td>{requirement.title}</td>
                  <td>{humanize(requirement.priority)}</td>
                  <td>
                    <Badge tone={toneFor(requirement.status)}>{humanize(requirement.status)}</Badge>
                  </td>
                  <td>
                    <select
                      className="ui-input"
                      aria-label={`Change status of ${requirement.key}`}
                      value=""
                      onChange={(event) => {
                        changeStatus.mutate({ id: requirement.id, status: event.target.value });
                      }}
                    >
                      <option value="">Choose…</option>
                      {REQUIREMENT_STATUSES.filter((value) => value !== requirement.status).map(
                        (value) => (
                          <option key={value} value={value}>
                            {humanize(value)}
                          </option>
                        ),
                      )}
                    </select>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCoverageFor((current) =>
                          current === requirement.id ? null : requirement.id,
                        );
                      }}
                    >
                      {coverageFor === requirement.id ? 'Hide test cases' : 'Test cases'}
                    </Button>
                  </td>
                </tr>
                {coverageFor === requirement.id && (
                  <tr>
                    <td colSpan={6}>
                      <CoverageLinks
                        side="requirement"
                        entityId={requirement.id}
                        projectId={activeProjectId}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
