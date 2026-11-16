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
import { t } from '../i18n/i18n';

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
      setError(cause instanceof ApiError ? cause.message : t('testPlans.couldNotCreateTheTest'));
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
        title={t('testPlans.testPlans')}
        description={t('testPlans.planQaWorkAboveSuites')}
      />
      {can('testruns.create') && (
        <form
          className="card"
          aria-label={t('testPlans.newTestPlan')}
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
            label={t('testPlans.planName')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <SelectField
            label={t('testPlans.planRelease')}
            value={releaseId}
            options={[{ value: '', label: t('testPlans.noRelease') }, ...releaseOptions]}
            onChange={(event) => {
              setReleaseId(event.target.value);
            }}
          />
          <SelectField
            label={t('testPlans.planSuite')}
            value={suiteId}
            options={[
              { value: '', label: t('testPlans.noSuiteYet') },
              ...(suites.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setSuiteId(event.target.value);
            }}
          />
          <SelectField
            label={t('testPlans.planEnvironment')}
            value={environmentId}
            options={[{ value: '', label: t('testPlans.noEnvironment') }, ...environmentOptions]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <TextField
            label={t('testPlans.planStartDate')}
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
          <TextField
            label={t('testPlans.planEndDate')}
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
          />
          <Button type="submit" disabled={create.isPending || name.trim().length < 3}>
            {t('testPlans.createTestPlan')}
          </Button>
        </form>
      )}
      <section className="card filters" aria-label={t('testPlans.testPlanFilters')}>
        <SelectField
          label={t('testPlans.planStatusFilter')}
          value={status}
          options={[
            { value: '', label: t('testPlans.notArchived') },
            ...TEST_PLAN_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value as TestPlanStatus | '');
          }}
        />
        <SelectField
          label={t('testPlans.planReleaseFilter')}
          value={releaseFilter}
          options={[{ value: '', label: t('testPlans.anyRelease') }, ...releaseOptions]}
          onChange={(event) => {
            setReleaseFilter(event.target.value);
          }}
        />
        <SelectField
          label={t('testPlans.planEnvironmentFilter')}
          value={environmentFilter}
          options={[{ value: '', label: t('testPlans.anyEnvironment') }, ...environmentOptions]}
          onChange={(event) => {
            setEnvironmentFilter(event.target.value);
          }}
        />
      </section>
      <DataState
        isPending={plans.isPending}
        error={plans.error}
        isEmpty={(plans.data?.data.length ?? 0) === 0}
        emptyMessage={t('testPlans.noTestPlanYet')}
      >
        <table className="table card" aria-label={t('testPlans.testPlans')}>
          <thead>
            <tr>
              <th scope="col">{t('testPlans.plan')}</th>
              <th scope="col">{t('testPlans.status')}</th>
              <th scope="col">{t('testPlans.owner')}</th>
              <th scope="col">{t('testPlans.release')}</th>
              <th scope="col">{t('testPlans.cases')}</th>
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
                <td>{entry.owner?.fullName ?? t('testPlans.nobody')}</td>
                <td>{entry.release?.version ?? t('testPlans.none')}</td>
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
