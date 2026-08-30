import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceabilityApi } from '../api/endpoints';
import { renderScreen } from '../test/render';

/**
 * Archiving is the interesting lifecycle change: the traceability link
 * survives, but the case stops counting as coverage, so a matrix left on the
 * previous answer reads as a data bug rather than a stale cache.
 */

const suites = [
  {
    id: 'suite_1',
    projectId: 'proj_1',
    name: 'Regression',
    description: null,
    position: 1,
    caseCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const testCase = {
  id: 'case_1',
  key: 'WEB-C-1',
  title: 'Pay with a valid card',
  status: 'active',
  version: 1,
  archivedAt: null as string | null,
};

function MatrixProbe(): React.JSX.Element {
  const matrix = useQuery({
    queryKey: ['matrix', 'proj_1', false],
    queryFn: () => traceabilityApi.matrix('proj_1'),
  });
  return <span data-testid="matrix">{matrix.isFetching ? 'loading' : 'idle'}</span>;
}

function stubApi(archived: boolean): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/traceability/matrix')) {
      return new Response(JSON.stringify({ requirements: [], summary: {} }), { status: 200 });
    }
    if (url.includes('/test-suites')) {
      return new Response(JSON.stringify(url.includes('/sections') ? [] : suites), { status: 200 });
    }
    if (url.includes('/archive') || url.includes('/restore')) {
      return new Response(JSON.stringify(testCase), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        data: [{ ...testCase, archivedAt: archived ? '2026-01-02T00:00:00.000Z' : null }],
        meta: { total: 1, page: 1, pageSize: 100 },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const countCalls = (fetchMock: ReturnType<typeof vi.fn>, fragment: string): number =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(fragment)).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../project/project-context');
});

async function renderPage(): Promise<void> {
  vi.doMock('../project/project-context', () => ({
    useProject: () => ({ activeProjectId: 'proj_1' }),
  }));
  const { TestCasesPage } = await import('./TestCasesPage');
  renderScreen(
    <>
      <TestCasesPage />
      <MatrixProbe />
    </>,
  );
}

describe('TestCasesPage', () => {
  it('refreshes the matrix and the suite counts when a case is archived', async () => {
    const fetchMock = stubApi(false);
    await renderPage();

    await waitFor(() => {
      expect(countCalls(fetchMock, '/traceability/matrix')).toBe(1);
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(countCalls(fetchMock, '/traceability/matrix')).toBe(2);
    });
    // The tree label counts cases; leaving it stale showed "Regression (1)"
    // next to an empty table.
    await waitFor(() => {
      expect(countCalls(fetchMock, '/test-suites?')).toBe(2);
    });
  });

  it('offers Restore for an archived case and refreshes the matrix again', async () => {
    const fetchMock = stubApi(true);
    await renderPage();

    await userEvent.click(await screen.findByLabelText(/show archived cases/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes('/test-cases/case_1/restore'),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(countCalls(fetchMock, '/traceability/matrix')).toBe(2);
    });
  });
});
