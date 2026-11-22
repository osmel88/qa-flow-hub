import type { DefectView, ReleaseView, TestRunView } from '@qa-flow-hub/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { renderScreen } from '../test/render';

const updateDefect = vi.fn();
const updateRelease = vi.fn();
const updateRun = vi.fn();

vi.mock('../api/endpoints', () => ({
  defectsApi: { update: (...args: unknown[]) => updateDefect(...args) },
  releasesApi: { update: (...args: unknown[]) => updateRelease(...args) },
  testRunsApi: { update: (...args: unknown[]) => updateRun(...args) },
  defectWorkflowApi: {},
  buildsApi: {},
}));

const defect: DefectView = {
  id: 'def_1',
  projectId: 'proj_1',
  key: 'ACME-D1',
  title: 'Checkout fails',
  description: null,
  stepsToReproduce: null,
  severity: 'major',
  priority: 'medium',
  status: 'open',
  environment: null,
  testResultId: null,
  testCaseId: null,
  testRunId: null,
  reportedById: null,
  assigneeId: null,
  resolvedAt: null,
  closedAt: null,
  customFields: {},
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const release: ReleaseView = {
  id: 'rel_1',
  projectId: 'proj_1',
  name: 'Spring launch',
  version: '2.4.0',
  tag: null,
  description: null,
  status: 'planned',
  startDate: '2026-10-01',
  targetDate: '2026-10-31',
  releasedAt: null,
  archivedAt: null,
  createdById: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  runCount: 0,
};

beforeEach(() => {
  updateDefect.mockReset();
  updateRelease.mockReset();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('editing a defect', () => {
  it('sends only the descriptive fields and blocks a too-short title (ES)', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    updateDefect.mockResolvedValue(defect);
    const onDone = vi.fn();
    const { EditDefect } = await import('./DefectsPage');
    renderScreen(<EditDefect defect={defect} onDone={onDone} />);

    const title = screen.getByLabelText('Título');
    await userEvent.clear(title);
    await userEvent.type(title, 'ab');
    expect(screen.getByText('El título debe tener al menos 3 caracteres')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();

    await userEvent.type(title, 'c');
    await userEvent.selectOptions(screen.getByLabelText('Prioridad'), 'high');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      expect(updateDefect).toHaveBeenCalledWith('def_1', {
        title: 'abc',
        description: null,
        severity: 'major',
        priority: 'high',
      });
    });
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
  });
});

describe('editing a release', () => {
  it('opens the form, rejects dates out of order and saves (EN)', async () => {
    updateRelease.mockResolvedValue(release);
    const { EditRelease } = await import('./ReleaseDetailPage');
    renderScreen(<EditRelease release={release} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit release' }));
    const target = screen.getByLabelText('Target date');
    await userEvent.clear(target);
    await userEvent.type(target, '2026-09-01');
    expect(screen.getByText('The target date cannot be before the start date')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await userEvent.clear(target);
    await userEvent.type(target, '2026-11-15');
    await userEvent.type(screen.getByLabelText('Tag'), 'v2.4.0');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateRelease).toHaveBeenCalledWith('rel_1', {
        name: 'Spring launch',
        tag: 'v2.4.0',
        description: null,
        startDate: '2026-10-01',
        targetDate: '2026-11-15',
      });
    });
  });
});

const run: TestRunView = {
  id: 'run_1',
  projectId: 'proj_1',
  name: 'Regression 2.4',
  description: null,
  milestone: null,
  environment: 'staging',
  releaseId: null,
  status: 'in_progress',
  startedAt: '2026-10-02T00:00:00.000Z',
  completedAt: null,
  createdById: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  progress: { total: 0, executed: 0, completion: 0 } as TestRunView['progress'],
};

describe('EditRun', () => {
  it('edits the run fields in Spanish and blocks a short name', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    updateRun.mockResolvedValue(run);
    const { EditRun } = await import('./RunExecutionPage');
    const user = userEvent.setup();
    renderScreen(<EditRun run={run} />);

    await user.click(screen.getByRole('button', { name: 'Editar ejecución' }));
    const name = screen.getByLabelText('Nombre');
    await user.clear(name);
    await user.type(name, 'ab');
    expect(screen.getByText('El nombre debe tener al menos 3 caracteres.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();

    await user.type(name, 'c');
    await user.type(screen.getByLabelText('Hito'), 'M3');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => {
      expect(updateRun).toHaveBeenCalledWith('run_1', {
        name: 'abc',
        description: null,
        milestone: 'M3',
        environment: 'staging',
      });
    });
  });
});
