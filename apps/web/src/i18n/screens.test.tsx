import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { humanize } from '../components/status';
import { renderScreen } from '../test/render';
import { LOCALE_STORAGE_KEY } from './locales';

/**
 * Product screens read the same catalogs as the auth screens: with Spanish
 * stored, nothing on them should stay in English, while data such as project
 * keys and names is shown as typed.
 */

const project = {
  id: 'proj_1',
  organizationId: 'org_1',
  key: 'WEB',
  name: 'Web shop',
  description: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    list: () => Promise.resolve({ data: [project], page: 1, pageSize: 20, total: 1 }),
    create: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  },
  testPlansApi: {
    list: () => Promise.resolve({ data: [], page: 1, pageSize: 50, total: 0 }),
    create: vi.fn(),
  },
  releasesApi: { list: () => Promise.resolve({ data: [], page: 1, pageSize: 50, total: 0 }) },
  environmentsApi: { list: () => Promise.resolve([]) },
  testDesignApi: { suites: () => Promise.resolve([]) },
}));

vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({
    activeOrganization: { id: 'org_1', name: 'Acme', role: 'organization_owner' },
  }),
}));

vi.mock('../project/project-context', () => ({
  useProject: () => ({
    activeProjectId: 'proj_1',
    activeProject: project,
    projects: [project],
    selectProject: vi.fn(),
  }),
}));

vi.mock('../components/use-project-permissions', () => ({
  useProjectPermissions: () => ({ can: () => true, isPending: false }),
}));

afterEach(() => {
  window.localStorage.clear();
});

describe('translated product screens', () => {
  it('renders Projects in Spanish and keeps the project data as entered', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    const { ProjectsPage } = await import('../pages/ProjectsPage');
    renderScreen(<ProjectsPage />);

    expect(screen.getByRole('heading', { name: 'Proyectos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nuevo proyecto' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre')).toBeInTheDocument();
    expect(screen.getByLabelText('Clave')).toBeInTheDocument();
    expect(
      screen.getByText(/De 2 a 8 letras mayúsculas o dígitos, empezando por una letra\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear proyecto' })).toBeDisabled();

    expect(await screen.findByText('Web shop')).toBeInTheDocument();
    expect(screen.getByText('WEB')).toBeInTheDocument();
    for (const header of ['Clave', 'Nombre', 'Estado', 'Acciones']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
    expect(screen.getByText('activo')).toBeInTheDocument();
    expect(screen.queryByText('Create project')).toBeNull();
    expect(screen.queryByText('active')).toBeNull();
  });

  it('shows the Spanish key rule as the validation error', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    const { ProjectsPage } = await import('../pages/ProjectsPage');
    const user = userEvent.setup();
    renderScreen(<ProjectsPage />);
    await user.type(screen.getByLabelText('Clave'), '1qa');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'De 2 a 8 letras mayúsculas o dígitos, empezando por una letra.',
    );
  });

  it('renders a Test Management screen in Spanish', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    const { TestPlansPage } = await import('../pages/TestPlansPage');
    renderScreen(<TestPlansPage />);

    expect(screen.getByRole('heading', { name: 'Planes de prueba' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear plan de prueba' })).toBeInTheDocument();
    expect(await screen.findByText('Todavía no hay planes de prueba.')).toBeInTheDocument();
    expect(screen.queryByText('Test plans')).toBeNull();
  });

  it('keeps English when no language is stored', async () => {
    const { ProjectsPage } = await import('../pages/ProjectsPage');
    renderScreen(<ProjectsPage />);
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(await screen.findByText('active')).toBeInTheDocument();
  });

  it('labels domain values in the active language and leaves unknown ones readable', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    const { ProjectsPage } = await import('../pages/ProjectsPage');
    renderScreen(<ProjectsPage />);
    expect(humanize('in_progress')).toBe('en curso');
    expect(humanize('some_new_value')).toBe('some new value');
  });
});

describe('shared validation messages', () => {
  it('maps known schema messages to the active language and leaves unknown ones untouched', async () => {
    const { validationMessage } = await import('./validation');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    renderScreen(<p>es</p>);
    expect(validationMessage('Password must be at least 12 characters')).toBe(
      'La contraseña debe tener al menos 12 caracteres',
    );
    expect(validationMessage('expects a number')).toBe('espera un número');
    expect(validationMessage('Some message from elsewhere')).toBe('Some message from elsewhere');
  });
});
