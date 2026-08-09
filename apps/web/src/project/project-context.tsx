import type { ProjectView } from '@qa-flow-hub/shared';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { projectsApi } from '../api/endpoints';
import { useAuth } from '../auth/auth-context';

interface ProjectContextValue {
  projects: ProjectView[];
  activeProject: ProjectView | null;
  activeProjectId: string | null;
  selectProject: (projectId: string) => void;
  isPending: boolean;
  error: unknown;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const STORAGE_KEY = 'qafh.projectId';

/**
 * Almost every screen is scoped to a project, so the choice lives once in the
 * shell instead of as a filter repeated on eight pages. The selection is keyed
 * by organization: switching tenants must not leave a stale project id that
 * belongs to somebody else's data.
 */
export function ProjectProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { activeOrganizationId } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ['projects', activeOrganizationId],
    queryFn: () => projectsApi.list(),
    enabled: activeOrganizationId !== null,
  });

  const projects = useMemo(() => data?.data ?? [], [data]);

  useEffect(() => {
    if (projects.length === 0) {
      setSelected(null);
      return;
    }
    const stored = localStorage.getItem(`${STORAGE_KEY}.${activeOrganizationId ?? ''}`);
    setSelected(
      projects.find((project) => project.id === stored)?.id ?? projects[0]?.id ?? null,
    );
  }, [projects, activeOrganizationId]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      activeProjectId: selected,
      activeProject: projects.find((project) => project.id === selected) ?? null,
      selectProject: (projectId) => {
        localStorage.setItem(`${STORAGE_KEY}.${activeOrganizationId ?? ''}`, projectId);
        setSelected(projectId);
      },
      isPending,
      error,
    }),
    [projects, selected, isPending, error, activeOrganizationId],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (context === null) {
    throw new Error('useProject must be used inside ProjectProvider');
  }
  return context;
}
