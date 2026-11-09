import type { TestCycleStatus, TestPlanView } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { testCyclesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { humanize } from '../components/status';

export const TEST_CYCLE_TONE: Record<TestCycleStatus, BadgeTone> = {
  planned: 'neutral',
  active: 'info',
  completed: 'success',
  cancelled: 'warning',
  archived: 'neutral',
};

/** The cycles of a test plan (S7-F2), with a form to plan a new one. */
export function TestCyclesSection({
  plan,
  canCreate,
}: {
  plan: TestPlanView;
  canCreate: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cycles = useQuery({
    queryKey: ['test-cycles', plan.id],
    queryFn: () => testCyclesApi.list(plan.id),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const create = useMutation({
    mutationFn: () =>
      testCyclesApi.create({
        testPlanId: plan.id,
        name: name.trim(),
        ...(environmentId === '' ? {} : { environmentId }),
      }),
    onSuccess: async () => {
      setName('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['test-cycles', plan.id] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the cycle.');
    },
  });
  const rows = cycles.data?.data ?? [];
  return (
    <section className="card" aria-labelledby="plan-cycles">
      <h2 id="plan-cycles">Cycles</h2>
      {rows.length === 0 ? (
        <p className="muted">No cycle yet.</p>
      ) : (
        <table className="table" aria-label="Plan cycles">
          <thead>
            <tr>
              <th scope="col">Cycle</th>
              <th scope="col">Status</th>
              <th scope="col">Environment</th>
              <th scope="col">Release</th>
              <th scope="col">Cases</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.id} data-testid={`cycle-${entry.name}`}>
                <td>
                  <Link to={`/test-cycles/${entry.id}`}>{entry.name}</Link>
                </td>
                <td>
                  <Badge tone={TEST_CYCLE_TONE[entry.status]}>{humanize(entry.status)}</Badge>
                </td>
                <td>{entry.environment?.name ?? 'any'}</td>
                <td>{entry.release?.version ?? 'none'}</td>
                <td>
                  {entry.scope.caseCount}
                  {entry.scope.frozen && ` (frozen from plan v${entry.scope.planVersion ?? 0})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canCreate && (
        <form
          aria-label="New cycle"
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
            label="Cycle name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <SelectField
            label="Cycle environment"
            value={environmentId}
            options={[
              { value: '', label: 'Any environment' },
              ...plan.environments.map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <Button type="submit" size="sm" disabled={create.isPending || name.trim().length < 3}>
            Create cycle
          </Button>
        </form>
      )}
    </section>
  );
}
