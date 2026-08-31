import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceabilityApi } from '../api/endpoints';
import { renderScreen } from '../test/render';
import { CoverageLinks } from './CoverageLinks';

const link = {
  id: 'link_1',
  sourceType: 'requirement',
  sourceId: 'req_1',
  targetType: 'test_case',
  targetId: 'case_1',
  linkType: 'verifies',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const cases = {
  data: [
    { id: 'case_1', key: 'WEB-C-1', title: 'Pay with a valid card' },
    { id: 'case_2', key: 'WEB-C-2', title: 'Pay with an expired card' },
  ],
  meta: { total: 2, page: 1, pageSize: 100 },
};

/** Subscribes to the matrix so an invalidation shows up as a real refetch. */
function MatrixProbe(): React.JSX.Element {
  const matrix = useQuery({
    queryKey: ['matrix', 'proj_1', false],
    queryFn: () => traceabilityApi.matrix('proj_1'),
  });
  return <span data-testid="matrix">{matrix.isFetching ? 'loading' : 'idle'}</span>;
}

function stubApi(links: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/traceability/links')) {
      return new Response(JSON.stringify(links), { status: 200 });
    }
    if (url.includes('/traceability/matrix')) {
      return new Response(JSON.stringify({ requirements: [], summary: {} }), { status: 200 });
    }
    return new Response(JSON.stringify(cases), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const matrixCalls = (fetchMock: ReturnType<typeof vi.fn>): number =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes('/traceability/matrix')).length;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CoverageLinks', () => {
  it('links a requirement to a case and makes the matrix ask again', async () => {
    const fetchMock = stubApi([]);
    renderScreen(
      <>
        <CoverageLinks side="requirement" entityId="req_1" projectId="proj_1" />
        <MatrixProbe />
      </>,
    );

    await screen.findByText(/no test case verifies this requirement yet/i);
    await waitFor(() => {
      expect(matrixCalls(fetchMock)).toBe(1);
    });

    await userEvent.selectOptions(await screen.findByLabelText('Link a test case'), 'case_2');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));

    // The link is always written requirement -> test_case, whichever screen the
    // user started from, because that is the direction the matrix reads.
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      const body = (posted?.[1] as RequestInit | undefined)?.body;
      expect(typeof body).toBe('string');
      expect(JSON.parse(body as string)).toMatchObject({
        sourceType: 'requirement',
        sourceId: 'req_1',
        targetType: 'test_case',
        targetId: 'case_2',
      });
    });

    await waitFor(() => {
      expect(matrixCalls(fetchMock)).toBe(2);
    });
  });

  it('unlinks from the case side and makes the matrix ask again', async () => {
    const fetchMock = stubApi([link]);
    renderScreen(
      <>
        <CoverageLinks side="test_case" entityId="case_1" projectId="proj_1" />
        <MatrixProbe />
      </>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/traceability/links/link_1') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(matrixCalls(fetchMock)).toBe(2);
    });
  });
});
