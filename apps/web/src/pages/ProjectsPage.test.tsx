import { PROJECT_KEY_RULE } from '@qa-flow-hub/shared';
import type { ProjectView } from '@qa-flow-hub/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http-client';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { renderScreen } from '../test/render';
import { ProjectsPage, canCreateProjects, projectKeyError } from './ProjectsPage';

const create = vi.fn();
const update = vi.fn();
const archive = vi.fn();
const restore = vi.fn();
const state: { role: string; projects: ProjectView[]; canManage: boolean } = {
  role: 'organization_owner',
  projects: [],
  canManage: true,
};

const webProject: ProjectView = {
  id: 'proj_1',
  key: 'WEB',
  name: 'Web shop',
  description: null,
  status: 'active',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    list: () =>
      Promise.resolve({
        data: state.projects,
        page: 1,
        pageSize: 20,
        total: state.projects.length,
      }),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
    archive: (...args: unknown[]) => archive(...args),
    restore: (...args: unknown[]) => restore(...args),
  },
}));

vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({ activeOrganization: { id: 'org_1', name: 'Acme', role: state.role } }),
}));

vi.mock('../project/project-context', () => ({
  useProject: () => ({ selectProject: vi.fn(), projects: [], activeProjectId: null }),
}));

vi.mock('../components/use-project-permissions', () => ({
  useProjectPermissions: () => ({ can: () => state.canManage, isPending: false }),
}));

beforeEach(() => {
  state.role = 'organization_owner';
  state.projects = [];
  state.canManage = true;
  for (const mock of [create, update, archive, restore]) mock.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('project key validation', () => {
  it.each(['QA', 'WEB', 'WEB2', 'QA01'])('accepts %s', (key) => {
    expect(projectKeyError(key)).toBeUndefined();
  });

  it.each(['1QA', 'Q', 'WEB-2', 'WEB_2', 'ABCDEFGHI', 'W EB', 'QA ', 'QA!', 'Q$'])(
    'rejects %j',
    (key) => {
      expect(projectKeyError(key)).toBe(PROJECT_KEY_RULE);
    },
  );

  it('validates while typing and keeps Create project disabled until both fields are valid', async () => {
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);
    const button = screen.getByRole('button', { name: 'Create project' });
    expect(screen.getByText(new RegExp(PROJECT_KEY_RULE.replace('.', '\\.')))).toBeInTheDocument();
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Name'), 'Web shop');
    await user.type(screen.getByLabelText('Key'), '1qa');
    expect(screen.getByLabelText('Key')).toHaveValue('1QA');
    expect(screen.getByRole('alert')).toHaveTextContent(PROJECT_KEY_RULE);
    expect(screen.getByLabelText('Key')).toHaveAttribute('aria-invalid', 'true');
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText('Key'));
    await user.type(screen.getByLabelText('Key'), 'web2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button).toBeEnabled();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'W');
    expect(button).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('who may create a project', () => {
  it('matches the roles of POST /projects', () => {
    expect(canCreateProjects('organization_owner')).toBe(true);
    expect(canCreateProjects('organization_admin')).toBe(true);
    for (const role of ['project_manager', 'qa_lead', 'tester', 'viewer'] as const) {
      expect(canCreateProjects(role)).toBe(false);
    }
    expect(canCreateProjects(undefined)).toBe(false);
  });

  it('tells a QA lead in Spanish that the role cannot create projects, with the form disabled', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    state.role = 'qa_lead';
    renderScreen(<ProjectsPage />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Tu rol no permite crear proyectos en esta organización.',
    );
    expect(screen.getByLabelText('Nombre')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Crear proyecto' })).toBeDisabled();
  });

  it('explains a FORBIDDEN answer with the project-specific message', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    create.mockRejectedValueOnce(
      new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action'),
    );
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);
    await user.type(screen.getByLabelText('Nombre'), 'Web shop');
    await user.type(screen.getByLabelText('Clave'), 'WEB');
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tu rol no permite crear proyectos en esta organización.',
    );
  });

  it('shows the plan limit, not a generic error', async () => {
    create.mockRejectedValueOnce(new ApiError(402, 'PLAN_LIMIT_REACHED', 'Plan limit reached'));
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);
    await user.type(screen.getByLabelText('Name'), 'Web shop');
    await user.type(screen.getByLabelText('Key'), 'WEB');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('link', { name: 'See plans and usage' })).toBeInTheDocument();
  });
});

describe('project actions', () => {
  it('opens, edits and asks before archiving', async () => {
    state.projects = [webProject];
    update.mockResolvedValueOnce({ ...webProject, name: 'Web store' });
    archive.mockResolvedValueOnce({ ...webProject, status: 'archived' });
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);

    expect(await screen.findByRole('button', { name: 'Open WEB' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit WEB' }));
    const nameField = screen.getAllByLabelText('Name')[1] as HTMLInputElement;
    await user.clear(nameField);
    await user.type(nameField, 'Web store');
    await user.type(screen.getByLabelText('Description'), 'Storefront');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('proj_1', {
        name: 'Web store',
        description: 'Storefront',
      });
    });

    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(archive).not.toHaveBeenCalled();
    expect(screen.getByText(/Archive WEB\? It becomes read-only/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, archive' }));
    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith('proj_1');
    });
    expect(screen.getByText(/Projects are archived, not deleted/)).toBeInTheDocument();
  });

  it('restores an archived project and offers no edit for it', async () => {
    state.projects = [{ ...webProject, status: 'archived' }];
    restore.mockResolvedValueOnce(webProject);
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(restore).toHaveBeenCalledWith('proj_1');
    expect(screen.queryByRole('button', { name: 'Edit WEB' })).toBeNull();
  });

  it('only lets a member without project.manage open the project', async () => {
    state.projects = [webProject];
    state.canManage = false;
    renderScreen(<ProjectsPage />);
    expect(await screen.findByRole('button', { name: 'Open WEB' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit WEB' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });
});
