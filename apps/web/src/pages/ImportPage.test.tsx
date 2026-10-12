import { computeEffectivePermissions } from '@qa-flow-hub/shared';
import type { ImportJobView, OrganizationRoleName } from '@qa-flow-hub/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';

/**
 * The wizard must never offer "Import" for a file with errors, must show each
 * issue with its row and column, and must hide itself from roles without
 * `test_design.import` (the API refuses them anyway).
 */

const baseJob: ImportJobView = {
  id: 'job_1',
  projectId: 'proj_1',
  createdById: 'u_1',
  format: 'qaflow_csv',
  status: 'invalid',
  fileName: 'cases.csv',
  fileSizeBytes: 120,
  checksum: 'a'.repeat(64),
  targetSuiteId: null,
  targetSuiteName: 'Imported',
  summary: {
    rows: 2,
    cases: 1,
    steps: 0,
    newSuites: 1,
    newSections: 0,
    links: 0,
    duplicates: 0,
    errors: 1,
    warnings: 1,
  },
  issues: [
    {
      row: 2,
      column: 'title',
      code: 'TOO_SHORT',
      severity: 'error',
      message: 'Title must be at least 3 characters',
    },
    {
      row: 3,
      column: 'priority',
      code: 'INVALID_ENUM',
      severity: 'warning',
      message: 'Unknown priority "urgent"; medium will be used',
    },
  ],
  issueCount: 2,
  expiresAt: '2026-10-05T00:00:00.000Z',
  committedAt: null,
  createdAt: '2026-10-04T00:00:00.000Z',
};

const readyJob: ImportJobView = {
  ...baseJob,
  id: 'job_2',
  status: 'ready',
  summary: { ...baseJob.summary, cases: 2, errors: 0, warnings: 0 },
  issues: [],
  issueCount: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubApi(
  role: OrganizationRoleName,
  dryRun: ImportJobView = baseJob,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/permissions/me')) {
      return json({
        projectId: 'proj_1',
        userId: 'u_1',
        organizationRole: role,
        projectRole: null,
        effectiveRole: role,
        overrides: [],
        permissions: computeEffectivePermissions(role, []),
      });
    }
    if (url.includes('/imports/limits')) {
      return json({
        maxBytes: 5 * 1024 * 1024,
        maxRows: 20000,
        maxCases: 5000,
        maxColumns: 100,
        maxStepsPerCase: 100,
        maxSectionDepth: 5,
        jobTtlHours: 24,
      });
    }
    if (url.includes('/commit')) {
      return json({
        job: { ...readyJob, status: 'committed' },
        created: { cases: 2, steps: 0, sections: 0, suites: 1, links: 0 },
      });
    }
    if (url.includes('/imports') && init?.method === 'POST') {
      return json(dryRun, 201);
    }
    if (url.includes('/imports')) {
      return json([{ ...readyJob, status: 'committed', issues: undefined }]);
    }
    if (url.includes('/test-suites')) {
      return json([]);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../project/project-context');
});

async function renderPage(): Promise<void> {
  vi.doMock('../project/project-context', () => ({
    useProject: () => ({ activeProjectId: 'proj_1' }),
  }));
  const { ImportPage } = await import('./ImportPage');
  renderScreen(<ImportPage />);
}

const chooseFile = async (): Promise<void> => {
  const file = new File(['title\nab\n'], 'cases.csv', { type: 'text/csv' });
  await userEvent.upload(await screen.findByLabelText('CSV file'), file);
  await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
};

describe('ImportPage', () => {
  it('shows each issue with row and column and keeps Import disabled while there are errors', async () => {
    const fetchMock = stubApi('qa_lead');
    await renderPage();
    await chooseFile();

    const report = await screen.findByRole('region', { name: 'Dry run report' });
    const issues = within(report).getByRole('table', { name: 'Import issues' });
    expect(within(issues).getByRole('cell', { name: 'TOO_SHORT' })).toBeInTheDocument();
    expect(within(issues).getAllByRole('row')[1]).toHaveTextContent(/2\s*title/);
    expect(within(report).getByRole('button', { name: /Import 1 test cases/ })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/commit'))).toBe(false);
  });

  it('commits a ready dry run and reports what was created', async () => {
    const fetchMock = stubApi('qa_lead', readyJob);
    await renderPage();
    await chooseFile();

    const confirm = await screen.findByRole('button', { name: 'Import 2 test cases' });
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(await screen.findByRole('status')).toHaveTextContent('Imported 2 test cases');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/projects/proj_1/imports/job_2/commit'),
      ),
    ).toBe(true);
  });

  it('lists the import history', async () => {
    stubApi('qa_lead');
    await renderPage();
    const history = await screen.findByRole('table', { name: 'Import history' });
    await waitFor(() => {
      expect(within(history).getByText('committed')).toBeInTheDocument();
    });
  });

  it('tells a tester they cannot import instead of showing the form', async () => {
    stubApi('tester');
    await renderPage();
    expect(await screen.findByText(/do not have permission to import/)).toBeInTheDocument();
    expect(screen.queryByLabelText('CSV file')).not.toBeInTheDocument();
  });
});
