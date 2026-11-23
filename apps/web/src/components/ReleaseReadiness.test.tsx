import type { ReadinessReason, ReleaseReadinessView } from '@qa-flow-hub/shared';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { PrintableReadinessPage } from '../pages/PrintableReadinessPage';
import { renderScreen } from '../test/render';
import { Route, Routes } from 'react-router-dom';
import { ReleaseReadinessSection } from './ReleaseReadiness';

const reason = (
  code: string,
  source: string,
  count: number,
  severity = 'blocker',
): ReadinessReason =>
  ({
    code,
    source,
    severity,
    count,
    message: 'English API message',
    items: [{ kind: 'defect', id: 'd1', label: 'WEB-D-1: Refund fails' }],
  }) as ReadinessReason;

const view = (overrides: Partial<ReleaseReadinessView> = {}): ReleaseReadinessView =>
  ({
    release: { id: 'rel_1', name: 'Spring launch', version: '2.4.0', status: 'in_progress' },
    project: { id: 'proj_1', key: 'WEB', name: 'Web shop' },
    decision: 'no_go',
    reasons: [reason('critical_defects_open', 'defects', 2)],
    blockers: [reason('critical_defects_open', 'defects', 2)],
    warnings: [reason('flaky_tests', 'flaky', 1, 'warning')],
    metrics: {
      qualityGates: {
        required: { result: 'failed', gateCount: 1 },
        gates: [{ id: 'g1', name: 'No criticals', required: true, result: 'failed' }],
        failed: 1,
        pending: 0,
      },
      execution: {
        runs: [{ id: 'run_1', name: 'Regression', status: 'completed' }],
        kpis: {
          planned: 12345,
          executed: 1000,
          pending: 234,
          verdicts: 1000,
          passRate: 95.5,
          failedRate: 4.5,
          blockedRate: 0,
          skippedRate: 0,
          untestedRate: 19,
          progress: 81,
        },
        rates: { passRate: 95.5, failedRate: 4.5, blockedRate: 0, insufficientData: false },
      },
      plans: [],
      cycles: [{ id: 'c1', name: 'Cycle one', status: 'active', completion: 50, passRate: null }],
      defects: {
        open: 2,
        bySeverity: { blocker: 0, critical: 2, major: 0, minor: 0, trivial: 0 },
        reopened: 0,
        critical: [],
        high: [],
      },
      requirements: {
        total: 3,
        covered: 2,
        uncovered: 1,
        coveredNotExecuted: 0,
        failing: 0,
        coverage: 66.7,
      },
      flaky: { flaky: 1, suspect: 0, failing: 0, confirmed: 0, dismissed: 0 },
      exploratory: {
        sessions: 0,
        incomplete: 0,
        findings: 0,
        openFindings: 0,
        convertedFindings: 0,
      },
    },
    thresholds: { minVerdicts: 5, maxFailedRate: 10 },
    computedAt: '2026-11-23T10:00:00.000Z',
    ...overrides,
  }) as ReleaseReadinessView;

function stub(body: ReleaseReadinessView): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('Release readiness', () => {
  it('shows the decision, the localized reasons and the KPIs in English', async () => {
    const fetchMock = stub(view());
    renderScreen(<ReleaseReadinessSection releaseId="rel_1" />);
    expect(await screen.findAllByText('NO-GO')).not.toHaveLength(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/releases/rel_1/readiness');
    expect(screen.getByText('Not ready: 1 blocker must be resolved first.')).toBeInTheDocument();
    expect(screen.getAllByText('2 blocker/critical defects remain open.')).toHaveLength(2);
    expect(
      screen.getByText('1 test case is flaky, suspect or failing repeatedly.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Quality gates' })).toHaveTextContent('No criticals');
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('66.7%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Printable readiness report' })).toHaveAttribute(
      'href',
      '/print/releases/rel_1/readiness',
    );
    expect(screen.queryByText('English API message')).not.toBeInTheDocument();
  });

  it('translates every part to Spanish', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    stub(view({ decision: 'go_with_risks', blockers: [], reasons: [] }));
    renderScreen(<ReleaseReadinessSection releaseId="rel_1" />);
    expect(await screen.findByText('GO CON RIESGOS')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preparación de la release' })).toBeInTheDocument();
    expect(
      screen.getByText('Se puede publicar asumiendo 1 riesgo, sin bloqueos.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('1 caso de prueba es inestable, sospechoso o falla de forma repetida.'),
    ).toBeInTheDocument();
    expect(screen.getByText('12.345')).toBeInTheDocument();
    expect(screen.getByText('66,7%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Informe de preparación imprimible' })).toBeVisible();
  });

  it('does not show rates below the minimum sample', async () => {
    const base = view();
    stub(
      view({
        decision: 'insufficient_data',
        blockers: [],
        warnings: [],
        reasons: [reason('not_enough_verdicts', 'execution', 3, 'info')],
        metrics: {
          ...base.metrics,
          execution: {
            ...base.metrics.execution,
            kpis: { ...base.metrics.execution.kpis, verdicts: 3 },
            rates: { passRate: null, failedRate: null, blockedRate: null, insufficientData: true },
          },
        },
      }),
    );
    renderScreen(<ReleaseReadinessSection releaseId="rel_1" />);
    expect(await screen.findByText('INSUFFICIENT DATA')).toBeInTheDocument();
    expect(
      screen.getByText('Only 3 verdicts recorded; at least 5 are needed.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Fewer than 5 verdicts: rates are not shown.')).toBeInTheDocument();
  });

  it('renders the printable report with release, project, date and decision', async () => {
    stub(view());
    renderScreen(
      <Routes>
        <Route path="/print/releases/:releaseId/readiness" element={<PrintableReadinessPage />} />
      </Routes>,
      '/print/releases/rel_1/readiness',
    );
    expect(
      await screen.findByRole('heading', { name: 'Readiness report: Spring launch · 2.4.0' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/WEB · Web shop · Generated/)).toBeInTheDocument();
    expect(screen.getAllByText('NO-GO')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /print/i })).toBeInTheDocument();
  });
});
