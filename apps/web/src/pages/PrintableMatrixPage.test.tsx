import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';

const matrix = {
  rows: [
    {
      requirementId: 'r1',
      key: 'WEB-R-1',
      title: '<script>alert(1)</script>',
      cases: [{ id: 'c1', key: 'WEB-C-1', title: 'Login', lastStatus: 'passed', archived: false }],
      covered: true,
      verified: true,
      defectIds: [],
    },
  ],
  summary: { requirements: 1, covered: 1, verified: 1, coverage: 100, openDefects: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../project/project-context');
});

describe('PrintableMatrixPage', () => {
  it('renders the matrix as escaped text and prints through the browser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(matrix), { status: 200 })),
    );
    const print = vi.fn();
    vi.stubGlobal('print', print);
    vi.doMock('../project/project-context', () => ({
      useProject: () => ({ activeProjectId: 'proj_1', activeProject: { name: 'Web' } }),
    }));
    const { PrintableMatrixPage } = await import('./PrintableMatrixPage');
    renderScreen(<PrintableMatrixPage />);

    const table = await screen.findByRole('table', { name: 'Traceability matrix' });
    expect(within(table).getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(within(table).getByText('WEB-C-1 (passed)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Traceability matrix — Web' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
  });
});
