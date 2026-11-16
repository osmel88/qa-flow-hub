import type { QaMetricsView } from '@qa-flow-hub/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { renderScreen } from '../test/render';

const get = vi.fn();

vi.mock('../api/endpoints', () => ({
  qaMetricsApi: { get: (...args: unknown[]) => get(...args) },
  testPlansApi: {
    list: () =>
      Promise.resolve({
        data: [{ id: 'plan_1', name: 'Release plan' }],
        page: 1,
        pageSize: 100,
        total: 1,
      }),
  },
  testCyclesApi: { list: () => Promise.resolve({ data: [], page: 1, pageSize: 100, total: 0 }) },
  releasesApi: { list: () => Promise.resolve({ data: [], page: 1, pageSize: 100, total: 0 }) },
  environmentsApi: { list: () => Promise.resolve([{ id: 'env_1', name: 'Staging' }]) },
}));

vi.mock('../project/project-context', () => ({
  useProject: () => ({ activeProjectId: 'proj_1' }),
}));

const zeroSeverity = { blocker: 0, critical: 0, major: 0, minor: 0, trivial: 0 };
const point = {
  bucketStart: '2027-01-01T00:00:00.000Z',
  bucketEnd: '2027-01-02T00:00:00.000Z',
};

function view(overrides: Partial<QaMetricsView> = {}): QaMetricsView {
  return {
    period: { from: '2027-01-01T00:00:00.000Z', to: '2027-01-31T00:00:00.000Z', bucket: 'day' },
    computedAt: '2027-01-31T00:00:00.000Z',
    projectId: 'proj_1',
    filters: { testPlanId: null, testCycleId: null, releaseId: null, environmentId: null },
    runs: 0,
    execution: {
      counts: { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
      planned: 0,
      executed: 0,
      pending: 0,
      verdicts: 0,
      passRate: null,
      failedRate: null,
      blockedRate: null,
      skippedRate: null,
      untestedRate: null,
      progress: null,
    },
    rates: { passRate: null, failedRate: null, blockedRate: null, insufficientData: false },
    trend: [{ ...point, passed: 0, failed: 0, blocked: 0, passRate: null }],
    plans: [],
    cycles: [],
    defects: {
      open: 0,
      openBySeverity: zeroSeverity,
      raisedInPeriod: 0,
      density: null,
      densityInsufficientData: false,
    },
    flaky: {
      counts: { flaky: 0, suspect: 0, failing: 0, stable: 0, insufficient_data: 0 },
      evolution: [{ ...point, flaky: 0, suspect: 0, failing: 0 }],
    },
    exploratory: {
      sessions: 0,
      byStatus: {},
      activeSeconds: 0,
      findings: 0,
      findingsByKind: {},
      findingsBySeverity: zeroSeverity,
      defectsCreated: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  get.mockReset();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('QaMetricsPage', () => {
  it('shows empty states and no percentages without data', async () => {
    get.mockResolvedValue(view());
    const { QaMetricsPage } = await import('./QaMetricsPage');
    renderScreen(<QaMetricsPage />);

    expect(await screen.findByText('No results were recorded in this period.')).toBeInTheDocument();
    expect(screen.getByText('No test plans match these filters.')).toBeInTheDocument();
    expect(screen.getByText('No exploratory sessions in this period.')).toBeInTheDocument();
    expect(screen.getByText('No case has enough results to classify yet.')).toBeInTheDocument();
    expect(screen.getByText('Needs at least 20 executed cases.')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('renders KPIs, hides rates of a small sample and sends the filters', async () => {
    get.mockResolvedValue(
      view({
        runs: 2,
        execution: {
          counts: { untested: 1, passed: 2, failed: 1, blocked: 0, skipped: 0 },
          planned: 4,
          executed: 3,
          pending: 1,
          verdicts: 3,
          passRate: 66.7,
          failedRate: 33.3,
          blockedRate: 0,
          skippedRate: 0,
          untestedRate: 25,
          progress: 75,
        },
        rates: { passRate: null, failedRate: null, blockedRate: null, insufficientData: true },
        plans: [
          {
            id: 'plan_1',
            name: 'Release plan',
            status: 'active',
            testPlanId: null,
            total: 4,
            executed: 3,
            passed: 2,
            failed: 1,
            blocked: 0,
            completion: 75,
            passRate: 66.7,
          },
        ],
      }),
    );
    const { QaMetricsPage } = await import('./QaMetricsPage');
    renderScreen(<QaMetricsPage />);

    expect(await screen.findByText('3 of 4 executed')).toBeInTheDocument();
    expect(screen.getAllByText('75%')).toHaveLength(2);
    expect(screen.getAllByText('Not enough data').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('link', { name: 'Release plan' })).toHaveAttribute(
      'href',
      '/test-plans/plan_1',
    );

    await screen.findByRole('option', { name: 'Staging' });
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'env_1');
    expect(get).toHaveBeenLastCalledWith('proj_1', { environmentId: 'env_1' });
  });

  it('renders in Spanish', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    get.mockResolvedValue(view());
    const { QaMetricsPage } = await import('./QaMetricsPage');
    renderScreen(<QaMetricsPage />);

    expect(screen.getByRole('heading', { name: 'Métricas de QA' })).toBeInTheDocument();
    const filters = screen.getByRole('region', { name: 'Filtros' });
    expect(within(filters).getByLabelText('Entorno')).toBeInTheDocument();
    expect(
      await screen.findByText('No hay sesiones exploratorias en este periodo.'),
    ).toBeInTheDocument();
  });
});
