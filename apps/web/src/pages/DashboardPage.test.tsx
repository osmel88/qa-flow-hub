import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { renderScreen } from '../test/render';

const summary = {
  projects: { active: 2, archived: 1 },
  requirements: { total: 4, byStatus: { approved: 3, draft: 1 } },
  testCases: { total: 9, byStatus: { ready: 9 } },
  runs: {
    active: 1,
    completed: 2,
    recent: [
      { id: 'run_1', name: 'Release 1.0', status: 'in_progress', completion: 40, startedAt: null },
    ],
  },
  results: { passed: 6, failed: 2 },
  defects: { open: 2, bySeverity: { critical: 1, major: 1 } },
  coverage: { requirements: 4, covered: 3, percentage: 75 },
};

vi.mock('../project/project-context', () => ({
  useProject: () => ({
    projects: [],
    activeProject: null,
    activeProjectId: null,
    selectProject: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardPage', () => {
  it('renders the aggregates the API returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(summary), { status: 200 })),
    );

    renderScreen(<DashboardPage />);

    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Release 1.0')).toBeInTheDocument();
    expect(screen.getByLabelText('Open defects by severity')).toHaveTextContent('critical');
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

    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
  });
});
