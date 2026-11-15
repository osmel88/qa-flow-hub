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
        title="Flaky tests"
        description="Stability of each case over its latest 20 passed/failed results, manual and automated. Recalculated on every visit."
      />
      <section className="card" aria-labelledby="flaky-heading">
        <h2 id="flaky-heading">Test cases</h2>
        <div className="filters">
          <SelectField
            label="Stability"
            value={status}
            options={[
              { value: '', label: 'Any stability' },
              ...FLAKY_STATUSES.map((entry) => ({ value: entry, label: humanize(entry) })),
            ]}
            onChange={(event) => {
              setStatus(event.target.value as FlakyStatus | '');
            }}
          />
          <SelectField
            label="Result source"
            value={source}
            options={FLAKY_SOURCES.map((entry) => ({ value: entry, label: humanize(entry) }))}
            onChange={(event) => {
              setSource(event.target.value as FlakySource);
            }}
          />
          <SelectField
            label="Suite"
            value={suiteId}
            options={[
              { value: '', label: 'Every suite' },
              ...(suites.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(event) => {
              setSuiteId(event.target.value);
            }}
          />
          <SelectField
            label="Manual mark"
            value={marked}
            options={[
              { value: '', label: 'Marked or not' },
              { value: 'true', label: 'Marked' },
              { value: 'false', label: 'Not marked' },
            ]}
            onChange={(event) => {
              setMarked(event.target.value as '' | 'true' | 'false');
            }}
          />
          <SelectField
            label="Sort by"
            value={sort}
            options={FLAKY_SORTS.map((entry) => ({ value: entry, label: humanize(entry) }))}
            onChange={(event) => {
              setSort(event.target.value as FlakySort);
            }}
          />
          <SelectField
            label="Order"
            value={order}
            options={[
              { value: 'desc', label: 'Descending' },
              { value: 'asc', label: 'Ascending' },
            ]}
            onChange={(event) => {
              setOrder(event.target.value as 'asc' | 'desc');
            }}
          />
          <TextField
            label="Search cases"
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
          emptyMessage="No executed case matches."
        >
          <table className="table" aria-label="Flaky tests">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Stability</th>
                <th scope="col">Executions</th>
                <th scope="col">Pass rate</th>
                <th scope="col">Fail rate</th>
                <th scope="col">Flips</th>
                <th scope="col">Flip rate</th>
                <th scope="col">Last result</th>
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
                    {row.confirmed && <small> confirmed</small>}
                    {row.dismissed && <small> dismissed</small>}
                  </td>
                  <td>
                    {row.executions} ({row.manualExecutions} manual · {row.automatedExecutions}{' '}
                    automated)
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
