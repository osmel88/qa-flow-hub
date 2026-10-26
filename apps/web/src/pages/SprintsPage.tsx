import { SPRINT_STATUSES } from '@qa-flow-hub/shared';
import type { SprintStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { sprintsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export const SPRINT_TONE: Record<SprintStatus, BadgeTone> = {
  planned: 'neutral',
  active: 'info',
  completed: 'success',
  cancelled: 'warning',
};

export function formatPoints(value: number | null): string {
  return value === null ? '—' : String(value);
}

export function SprintsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [capacity, setCapacity] = useState('');
  const [status, setStatus] = useState<SprintStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const projectId = activeProjectId ?? '';

  const sprints = useQuery({
    queryKey: ['sprints', activeProjectId, status],
    queryFn: () => sprintsApi.list({ projectId, ...(status === '' ? {} : { status }) }),
    enabled: activeProjectId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      sprintsApi.create({
        projectId,
        name: name.trim(),
        goal: goal.trim() === '' ? null : goal.trim(),
        startDate: startDate === '' ? null : startDate,
        endDate: endDate === '' ? null : endDate,
        capacity: capacity.trim() === '' ? null : Number(capacity),
      }),
    onSuccess: async () => {
      setName('');
      setGoal('');
      setStartDate('');
      setEndDate('');
      setCapacity('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['sprints'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the sprint.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  const velocity = sprints.data?.velocity;

  return (
    <>
      <PageHeader
        title="Sprints"
        description="Time boxes of the backlog. One sprint per project is active at a time; completed and cancelled sprints are kept as history."
      />

      {can('work_items.manage') && (
        <section className="card" aria-labelledby="new-sprint">
          <h2 id="new-sprint">New sprint</h2>
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          <TextField
            label="Sprint name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label="Goal"
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value);
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
            label="End date"
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
          />
          <TextField
            label="Capacity (points)"
            type="number"
            min={0}
            value={capacity}
            onChange={(event) => {
              setCapacity(event.target.value);
            }}
          />
          <Button
            loading={create.isPending}
            disabled={name.trim() === ''}
            onClick={() => {
              create.mutate();
            }}
          >
            Create sprint
          </Button>
        </section>
      )}

      <section className="card" aria-labelledby="velocity">
        <h2 id="velocity">Velocity</h2>
        <p>
          <strong data-testid="velocity">{formatPoints(velocity?.velocity ?? null)}</strong> points
          per sprint, average of the last {velocity?.sprints.length ?? 0} completed sprint(s).
        </p>
      </section>

      <SelectField
        label="Status filter"
        value={status}
        options={[
          { value: '', label: 'Any status' },
          ...SPRINT_STATUSES.map((value) => ({ value, label: humanize(value) })),
        ]}
        onChange={(event) => {
          setStatus(event.target.value as SprintStatus | '');
        }}
      />

      <DataState
        isPending={sprints.isPending}
        error={sprints.error}
        isEmpty={(sprints.data?.data.length ?? 0) === 0}
        emptyMessage="No sprint yet."
      >
        <table className="table card" aria-label="Sprints">
          <thead>
            <tr>
              <th scope="col">Sprint</th>
              <th scope="col">Status</th>
              <th scope="col">Dates</th>
              <th scope="col">Capacity</th>
              <th scope="col">Committed</th>
              <th scope="col">Completed</th>
            </tr>
          </thead>
          <tbody>
            {(sprints.data?.data ?? []).map((sprint) => (
              <tr key={sprint.id}>
                <td>
                  <Link to={`/sprints/${sprint.id}`}>{sprint.name}</Link>
                </td>
                <td>
                  <Badge tone={SPRINT_TONE[sprint.status]}>{humanize(sprint.status)}</Badge>
                </td>
                <td>
                  {sprint.startDate ?? '—'} → {sprint.endDate ?? '—'}
                </td>
                <td>{formatPoints(sprint.capacity)}</td>
                <td>{formatPoints(sprint.committedEstimate)}</td>
                <td>{formatPoints(sprint.completedEstimate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
