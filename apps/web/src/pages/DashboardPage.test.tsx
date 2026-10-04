import { coverageKpis, emptyExecutionCounts, executionKpis } from '@qa-flow-hub/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { renderScreen } from '../test/render';

const project = { id: 'prj_1', key: 'WEB', name: 'Web shop' };
const envelope = {
  period: { from: '2026-09-04T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', bucket: 'day' },
  computedAt: '2026-10-04T10:00:00.000Z',
};
const execution = executionKpis({ untested: 1, passed: 2, failed: 1, blocked: 1, skipped: 1 });
const coverage = coverageKpis(4, 3);
const points = [
  {
    bucketStart: '2026-10-02T00:00:00.000Z',
    bucketEnd: '2026-10-03T00:00:00.000Z',
    results: 2,
    passRate: 50,
    coverage: 50,
    defectsCreated: 1,
    defectsClosed: 0,
    defectsOpen: 1,
  },
  {
    bucketStart: '2026-10-03T00:00:00.000Z',
    bucketEnd: '2026-10-04T00:00:00.000Z',
    results: 0,
    passRate: null,
    coverage: 75,
    defectsCreated: 0,
    defectsClosed: 1,
    defectsOpen: 0,
  },
];

const responses: Record<string, unknown> = {
  summary: {
    ...envelope,
    projectId: project.id,
    execution,
    coverage,
    defects: {
      open: 2,
      openCritical: 1,
      createdInPeriod: 3,
      closedInPeriod: 1,
      perExecutedCase: 0.4,
    },
    meanTimeToResolve: { hours: 12.5, sampleSize: 2 },
    comparison: {
      previousPeriod: { from: '2026-08-05T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z' },
      passRate: { current: 50, previous: 40, delta: 10 },
      defectsCreated: { current: 3, previous: 1, delta: 2 },
    },
  },
  'test-results': {
    ...envelope,
    projectId: project.id,
    execution,
    runs: [
      {
        id: 'run_1',
        name: 'Release 1.0',
        milestone: '1.0',
        status: 'in_progress',
        createdAt: '2026-10-01T00:00:00.000Z',
        completedAt: null,
        execution,
        defects: 2,
        defectsPerExecutedCase: 0.4,
      },
    ],
    milestones: [{ milestone: '1.0', runs: 1, execution }],
  },
  coverage: {
    ...envelope,
    projectId: project.id,
    coverage,
    byPriority: [{ priority: 'critical', ...coverageKpis(2, 1) }],
    uncoveredRequirements: [
      {
        id: 'req_1',
        key: 'REQ-4',
        title: 'Refund an order',
        priority: 'critical',
        status: 'approved',
      },
    ],
  },
  defects: {
    ...envelope,
    projectId: project.id,
    open: 2,
    closed: 1,
    openCritical: 1,
    bySeverity: { blocker: 0, critical: 1, major: 1, minor: 0, trivial: 0 },
    byPriority: { critical: 0, high: 2, medium: 0, low: 0 },
    byStatus: {
      open: 2,
      triaged: 0,
      in_progress: 0,
      resolved: 0,
      closed: 1,
      rejected: 0,
      reopened: 0,
    },
    createdInPeriod: 3,
    closedInPeriod: 1,
    perExecutedCase: 0.4,
    meanTimeToResolve: { hours: 12.5, sampleSize: 2 },
  },
  trends: { ...envelope, projectId: project.id, points },
  organization: {
    ...envelope,
    health: { projects: 2, execution, coverage, openDefects: 4, openCritical: 2 },
    projects: [
      {
        projectId: project.id,
        key: 'WEB',
        name: 'Web shop',
        execution,
        coverage,
        openDefects: 2,
        openCritical: 1,
      },
      {
        projectId: 'prj_2',
        key: 'MOB',
        name: 'Mobile app',
        execution: executionKpis(emptyExecutionCounts()),
        coverage: coverageKpis(0, 0),
        openDefects: 2,
        openCritical: 1,
      },
    ],
    mostFailures: [{ projectId: project.id, key: 'WEB', name: 'Web shop', value: 1 }],
    leastCoverage: [{ projectId: project.id, key: 'WEB', name: 'Web shop', value: 75 }],
    trends: points,
    recentActivity: [
      {
        kind: 'defect',
        id: 'def_1',
        at: '2026-10-03T09:00:00.000Z',
        projectId: 'prj_2',
        projectKey: 'MOB',
        label: 'DEF-1 Crash on launch',
        status: 'blocker',
      },
    ],
  },
};

vi.mock('../project/project-context', () => ({
  useProject: () => ({
    projects: [project],
    activeProject: project,
    activeProjectId: project.id,
    selectProject: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

function stubApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'http://localhost');
    const part = url.pathname.endsWith('/dashboard/organization')
      ? 'organization'
      : (url.pathname.split('/').at(-1) ?? '');
    const body = responses[part];
    return body === undefined
      ? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Nope' } }), {
          status: 404,
        })
      : new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardPage', () => {
  it('renders the project KPIs the API computed, with an explicit window', async () => {
    const fetchMock = stubApi();

    renderScreen(<DashboardPage />);

    expect(await screen.findByText('+10 pts vs previous window')).toBeInTheDocument();
    expect(screen.getByText('Open defects', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('12.5 h')).toBeInTheDocument();
    expect(screen.getByText('3 of 4 requirements')).toBeInTheDocument();

    const urls = fetchMock.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input),
    );
    expect(urls.some((url) => url.includes('/projects/prj_1/dashboard/summary?from='))).toBe(true);
    expect(urls.every((url) => !url.includes('/test-results?') || url.includes('to='))).toBe(true);
  });

  it('pairs every chart with text: bar values, distribution table and trend data', async () => {
    stubApi();

    renderScreen(<DashboardPage />);

    const distribution = await screen.findByRole('region', { name: 'Result distribution' });
    expect(within(distribution).getByRole('row', { name: /failed 1 25%/i })).toBeInTheDocument();

    const severity = await screen.findByRole('region', { name: 'Open defects by severity' });
    expect(within(severity).getByText('critical')).toBeInTheDocument();

    const trend = await screen.findByRole('img', { name: /Pass rate and coverage/ });
    expect(trend).toHaveAccessibleName(expect.stringContaining('Coverage: from 50% to 75%'));
    expect(screen.getAllByText('Show data table').length).toBeGreaterThan(0);

    expect(await screen.findByText('Refund an order')).toBeInTheDocument();
    expect(screen.getByText('Release 1.0')).toBeInTheDocument();
  });

  it('switches to the organization view with rankings and recent activity', async () => {
    stubApi();
    const user = userEvent.setup();

    renderScreen(<DashboardPage />);
    await user.click(await screen.findByRole('button', { name: 'Organization' }));

    expect(await screen.findByText('Open critical defects')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Most failures' })).toHaveTextContent('1 failed');
    expect(screen.getByRole('region', { name: 'Least coverage' })).toHaveTextContent('75%');
    expect(screen.getByText('DEF-1 Crash on launch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Organization' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the error instead of an empty dashboard when the API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Boom' } }), {
            status: 500,
          }),
      ),
    );

    renderScreen(<DashboardPage />);

    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('Boom');
  });
});
