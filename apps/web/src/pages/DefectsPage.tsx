import { DEFECT_SEVERITIES, DEFECT_STATUSES } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { defectsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export function DefectsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('major');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['defects', activeProjectId, status],
    queryFn: () =>
      defectsApi.list({
        projectId: activeProjectId ?? '',
        ...(status === '' ? {} : { status }),
      }),
    enabled: activeProjectId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      defectsApi.create({
        projectId: activeProjectId ?? '',
        title,
        description: description === '' ? null : description,
        severity: severity as 'major',
        priority: 'medium',
        requirementIds: [],
      }),
    onSuccess: async () => {
      setTitle('');
      setDescription('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['defects'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the defect.');
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      defectsApi.changeStatus(input.id, input.status),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['defects'] });
    },
    onError: (cause) => {
      // Only the API knows which transitions are legal; repeating the state
      // machine here would be a second source of truth that drifts.
      setError(cause instanceof ApiError ? cause.message : 'Could not change the status.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title="Defects"
        description="Defects raised from a failed result keep a link back to the execution that found them."
      />

      <section className="card" aria-labelledby="new-defect">
        <h2 id="new-defect">Report a defect</h2>
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
        <SelectField
          label="Severity"
          hint="Severity is how badly it breaks; priority is when we will fix it. They are not the same field."
          options={DEFECT_SEVERITIES.map((value) => ({ value, label: humanize(value) }))}
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value);
          }}
        />
        <Button
          loading={create.isPending}
          disabled={title.trim().length < 3}
          onClick={() => {
            create.mutate();
          }}
        >
          Report defect
        </Button>
      </section>

      <section className="card filters" aria-label="Filters">
        <SelectField
          label="Status"
          options={[
            { value: '', label: 'Any status' },
            ...DEFECT_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
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
        emptyMessage="No defect matches these filters."
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Title</th>
              <th scope="col">Severity</th>
              <th scope="col">Status</th>
              <th scope="col">Origin</th>
              <th scope="col">Move to</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.data.map((defect) => (
              <tr key={defect.id}>
                <td>
                  <code>{defect.key}</code>
                </td>
                <td>{defect.title}</td>
                <td>
                  <Badge tone={toneFor(defect.severity)}>{humanize(defect.severity)}</Badge>
                </td>
                <td>
                  <Badge tone={toneFor(defect.status)}>{humanize(defect.status)}</Badge>
                </td>
                <td className="muted">
                  {defect.testResultId === null ? 'Reported manually' : 'From a test result'}
                </td>
                <td>
                  <select
                    className="ui-input"
                    aria-label={`Change status of ${defect.key}`}
                    value=""
                    onChange={(event) => {
                      changeStatus.mutate({ id: defect.id, status: event.target.value });
                    }}
                  >
                    <option value="">Choose…</option>
                    {DEFECT_STATUSES.filter((value) => value !== defect.status).map((value) => (
                      <option key={value} value={value}>
                        {humanize(value)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
