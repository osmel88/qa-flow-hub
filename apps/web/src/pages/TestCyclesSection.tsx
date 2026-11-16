import type { TestCycleStatus, TestPlanView } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { testCyclesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { humanize } from '../components/status';
import { t } from '../i18n/i18n';

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
      setError(
        cause instanceof ApiError ? cause.message : t('testCyclesSection.couldNotCreateTheCycle'),
      );
    },
  });
  const rows = cycles.data?.data ?? [];
  return (
    <section className="card" aria-labelledby="plan-cycles">
      <h2 id="plan-cycles">{t('testCyclesSection.cycles')}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t('testCyclesSection.noCycleYet')}</p>
      ) : (
        <table className="table" aria-label={t('testCyclesSection.planCycles')}>
          <thead>
            <tr>
              <th scope="col">{t('testCyclesSection.cycle')}</th>
              <th scope="col">{t('testCyclesSection.status')}</th>
              <th scope="col">{t('testCyclesSection.environment')}</th>
              <th scope="col">{t('testCyclesSection.release')}</th>
              <th scope="col">{t('testCyclesSection.cases')}</th>
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
                <td>{entry.environment?.name ?? t('testCyclesSection.any')}</td>
                <td>{entry.release?.version ?? t('testCyclesSection.none')}</td>
                <td>
                  {entry.scope.caseCount}
                  {entry.scope.frozen &&
                    t('testCyclesSection.frozenFromPlan', {
                      version: entry.scope.planVersion ?? 0,
                    })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canCreate && (
        <form
          aria-label={t('testCyclesSection.newCycle')}
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
            label={t('testCyclesSection.cycleName')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <SelectField
            label={t('testCyclesSection.cycleEnvironment')}
            value={environmentId}
            options={[
              { value: '', label: t('testCyclesSection.anyEnvironment') },
              ...plan.environments.map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <Button type="submit" size="sm" disabled={create.isPending || name.trim().length < 3}>
            {t('testCyclesSection.createCycle')}
          </Button>
        </form>
      )}
    </section>
  );
}
