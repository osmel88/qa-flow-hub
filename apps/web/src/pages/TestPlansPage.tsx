import { TEST_PLAN_STATUSES } from '@qa-flow-hub/shared';
import type { TestPlanStatus } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { environmentsApi, releasesApi, testDesignApi, testPlansApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

export const TEST_PLAN_TONE: Record<TestPlanStatus, BadgeTone> = {
  draft: 'neutral',
  active: 'info',
  completed: 'success',
  cancelled: 'warning',
  archived: 'neutral',
};

/** Test plans (S7-F1): the planning layer above suites and runs. */
export function TestPlansPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const projectId = activeProjectId ?? '';
  const [status, setStatus] = useState<TestPlanStatus | ''>('');
  const [releaseFilter, setReleaseFilter] = useState('');
  const [environmentFilter, setEnvironmentFilter] = useState('');
  const [name, setName] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enabled = activeProjectId !== null;
  const plans = useQuery({
    queryKey: ['test-plans', activeProjectId, status, releaseFilter, environmentFilter],
    queryFn: () =>
      testPlansApi.list({
        projectId,
        ...(status === '' ? {} : { status }),
        ...(releaseFilter === '' ? {} : { releaseId: releaseFilter }),
        ...(environmentFilter === '' ? {} : { environmentId: environmentFilter }),
      }),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, 'plan-options'],
    queryFn: () => releasesApi.list({ projectId }),
    enabled,
  });
  const environments = useQuery({
    queryKey: ['environments', activeProjectId, 'plan-options'],
    queryFn: () => environmentsApi.list({ projectId }),
    enabled,
  });
  const suites = useQuery({
    queryKey: ['suites', activeProjectId, 'plan-options'],
    queryFn: () => testDesignApi.suites(projectId),
    enabled,
  });
  const create = useMutation({
    mutationFn: () =>
      testPlansApi.create({
        projectId,
        name: name.trim(),
        ...(releaseId === '' ? {} : { releaseId }),
        ...(suiteId === '' ? {} : { suiteIds: [suiteId] }),
        ...(environmentId === '' ? {} : { environmentIds: [environmentId] }),
        ...(startDate === '' ? {} : { startDate }),
        ...(endDate === '' ? {} : { endDate }),
      }),
    onSuccess: async () => {
      setName('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['test-plans'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the test plan.');
    },
  });
  if (activeProjectId === null) {
    return <NoProject />;
  }
  const releaseOptions = (releases.data?.data ?? []).map((entry) => ({
    value: entry.id,
    label: `${entry.version} · ${entry.name}`,
  }));
  const environmentOptions = (environments.data ?? []).map((entry) => ({
    value: entry.id,
    label: entry.name,
  }));
  return (
    <>
      <PageHeader
        title="Test plans"
        description="Plan QA work above suites and runs. Starting a plan freezes its scope."
      />
      {can('testruns.create') && (
        <form
          className="card"
          aria-label="New test plan"
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
            label="Plan name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <SelectField
            label="Plan release"
            value={releaseId}
            options={[{ value: '', label: 'No release' }, ...releaseOptions]}
            onChange={(event) => {
              setReleaseId(event.target.value);
            }}
          />
          <SelectField
            label="Plan suite"
            value={suiteId}
            options={[
              { value: '', label: 'No suite yet' },
              ...(suites.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setSuiteId(event.target.value);
            }}
          />
          <SelectField
            label="Plan environment"
            value={environmentId}
            options={[{ value: '', label: 'No environment' }, ...environmentOptions]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <TextField
            label="Plan start date"
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
          <TextField
            label="Plan end date"
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
          />
          <Button type="submit" disabled={create.isPending || name.trim().length < 3}>
            Create test plan
          </Button>
        </form>
      )}
      <section className="card filters" aria-label="Test plan filters">
        <SelectField
          label="Plan status filter"
          value={status}
          options={[
            { value: '', label: 'Not archived' },
            ...TEST_PLAN_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value as TestPlanStatus | '');
          }}
        />
        <SelectField
          label="Plan release filter"
          value={releaseFilter}
          options={[{ value: '', label: 'Any release' }, ...releaseOptions]}
          onChange={(event) => {
            setReleaseFilter(event.target.value);
          }}
        />
        <SelectField
          label="Plan environment filter"
          value={environmentFilter}
          options={[{ value: '', label: 'Any environment' }, ...environmentOptions]}
          onChange={(event) => {
            setEnvironmentFilter(event.target.value);
          }}
        />
      </section>
      <DataState
        isPending={plans.isPending}
        error={plans.error}
        isEmpty={(plans.data?.data.length ?? 0) === 0}
        emptyMessage="No test plan yet."
      >
        <table className="table card" aria-label="Test plans">
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Status</th>
              <th scope="col">Owner</th>
              <th scope="col">Release</th>
              <th scope="col">Cases</th>
            </tr>
          </thead>
          <tbody>
            {(plans.data?.data ?? []).map((entry) => (
              <tr key={entry.id} data-testid={`plan-${entry.name}`}>
                <td>
                  <Link to={`/test-plans/${entry.id}`}>{entry.name}</Link>
                </td>
                <td>
                  <Badge tone={TEST_PLAN_TONE[entry.status]}>{humanize(entry.status)}</Badge>
                </td>
                <td>{entry.owner?.fullName ?? 'nobody'}</td>
                <td>{entry.release?.version ?? 'none'}</td>
                <td>
                  {entry.scope.caseCount}
                  {entry.scope.frozen && ` (frozen v${entry.scope.version})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
