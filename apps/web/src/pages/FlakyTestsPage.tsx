import { FLAKY_SORTS, FLAKY_SOURCES, FLAKY_STATUSES } from '@qa-flow-hub/shared';
import type { FlakySort, FlakySource, FlakyStatus } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { flakyApi, testDesignApi } from '../api/endpoints';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

export const FLAKY_TONE: Record<FlakyStatus, BadgeTone> = {
  flaky: 'danger',
  suspect: 'warning',
  failing: 'danger',
  stable: 'success',
  insufficient_data: 'neutral',
};

export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** Flaky test detection (S7-F6): test cases ranked by how unstable they are. */
export function FlakyTestsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const projectId = activeProjectId ?? '';
  const [status, setStatus] = useState<FlakyStatus | ''>('');
  const [source, setSource] = useState<FlakySource>('all');
  const [suiteId, setSuiteId] = useState('');
  const [marked, setMarked] = useState<'' | 'true' | 'false'>('');
  const [sort, setSort] = useState<FlakySort>('status');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const enabled = activeProjectId !== null;
  const rows = useQuery({
    queryKey: [
      'flaky-tests',
      activeProjectId,
      status,
      source,
      suiteId,
      marked,
      sort,
      order,
      search,
    ],
    queryFn: () =>
      flakyApi.list({
        projectId,
        source,
        sort,
        order,
        ...(status === '' ? {} : { status }),
        ...(suiteId === '' ? {} : { suiteId }),
        ...(marked === '' ? {} : { marked }),
        ...(search.trim() === '' ? {} : { q: search.trim() }),
      }),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const suites = useQuery({
    queryKey: ['suites', activeProjectId],
    queryFn: () => testDesignApi.suites(projectId),
    enabled,
  });
  if (activeProjectId === null) {
    return <NoProject />;
  }
  const data = rows.data?.data ?? [];
  return (
    <>
      <PageHeader
        title={t('flakyTests.flakyTests')}
        description={t('flakyTests.stabilityOfEachCaseOver')}
      />
      <section className="card" aria-labelledby="flaky-heading">
        <h2 id="flaky-heading">{t('flakyTests.testCases')}</h2>
        <div className="filters">
          <SelectField
            label={t('flakyTests.stability')}
            value={status}
            options={[
              { value: '', label: t('flakyTests.anyStability') },
              ...FLAKY_STATUSES.map((entry) => ({ value: entry, label: humanize(entry) })),
            ]}
            onChange={(event) => {
              setStatus(event.target.value as FlakyStatus | '');
            }}
          />
          <SelectField
            label={t('flakyTests.resultSource')}
            value={source}
            options={FLAKY_SOURCES.map((entry) => ({ value: entry, label: humanize(entry) }))}
            onChange={(event) => {
              setSource(event.target.value as FlakySource);
            }}
          />
          <SelectField
            label={t('flakyTests.suite')}
            value={suiteId}
            options={[
              { value: '', label: t('flakyTests.everySuite') },
              ...(suites.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setSuiteId(event.target.value);
            }}
          />
          <SelectField
            label={t('flakyTests.manualMark')}
            value={marked}
            options={[
              { value: '', label: t('flakyTests.markedOrNot') },
              { value: 'true', label: t('flakyTests.marked') },
              { value: 'false', label: t('flakyTests.notMarked') },
            ]}
            onChange={(event) => {
              setMarked(event.target.value as '' | 'true' | 'false');
            }}
          />
          <SelectField
            label={t('flakyTests.sortBy')}
            value={sort}
            options={FLAKY_SORTS.map((entry) => ({ value: entry, label: humanize(entry) }))}
            onChange={(event) => {
              setSort(event.target.value as FlakySort);
            }}
          />
          <SelectField
            label={t('flakyTests.order')}
            value={order}
            options={[
              { value: 'desc', label: t('flakyTests.descending') },
              { value: 'asc', label: t('flakyTests.ascending') },
            ]}
            onChange={(event) => {
              setOrder(event.target.value as 'asc' | 'desc');
            }}
          />
          <TextField
            label={t('flakyTests.searchCases')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <DataState
          isPending={rows.isPending}
          error={rows.error}
          isEmpty={data.length === 0}
          emptyMessage={t('flakyTests.noExecutedCaseMatches')}
        >
          <table className="table" aria-label={t('flakyTests.flakyTests')}>
            <thead>
              <tr>
                <th scope="col">{t('flakyTests.case')}</th>
                <th scope="col">{t('flakyTests.stability')}</th>
                <th scope="col">{t('flakyTests.executions')}</th>
                <th scope="col">{t('flakyTests.passRate')}</th>
                <th scope="col">{t('flakyTests.failRate')}</th>
                <th scope="col">{t('flakyTests.flips')}</th>
                <th scope="col">{t('flakyTests.flipRate')}</th>
                <th scope="col">{t('flakyTests.lastResult')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.testCase.id} data-testid={`flaky-${row.testCase.key}`}>
                  <td>
                    <Link to={`/flaky-tests/${row.testCase.id}`}>
                      {row.testCase.key} · {row.testCase.title}
                    </Link>
                    <br />
                    <small>{row.testCase.suiteName}</small>
                  </td>
                  <td>
                    <Badge tone={FLAKY_TONE[row.status]}>{humanize(row.status)}</Badge>
                    {row.confirmed && <small> {t('flakyTests.confirmed')}</small>}
                    {row.dismissed && <small> {t('flakyTests.dismissed')}</small>}
                  </td>
                  <td>
                    {row.executions} ({row.manualExecutions} {t('flakyTests.manual')}{' '}
                    {row.automatedExecutions} {t('flakyTests.automated')}
                  </td>
                  <td>{percent(row.passRate)}</td>
                  <td>{percent(row.failRate)}</td>
                  <td>{row.flips}</td>
                  <td>{percent(row.flipRate)}</td>
                  <td>{row.lastStatus ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataState>
      </section>
    </>
  );
}
