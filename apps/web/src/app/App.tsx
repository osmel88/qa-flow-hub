import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { AppLayout } from '../components/AppLayout';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { ProjectProvider } from '../project/project-context';
import { DashboardPage } from '../pages/DashboardPage';
import { DefectsPage } from '../pages/DefectsPage';
import { LoginPage } from '../pages/LoginPage';
import { MembersPage } from '../pages/MembersPage';
import { ProjectAccessPage } from '../pages/ProjectAccessPage';
import { OrganizationsPage } from '../pages/OrganizationsPage';
import { ProfilePage } from '../pages/ProfilePage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { RegisterPage } from '../pages/RegisterPage';
import { RequirementsPage } from '../pages/RequirementsPage';
import { RunExecutionPage } from '../pages/RunExecutionPage';
import { TestCaseEditorPage } from '../pages/TestCaseEditorPage';
import { TestCasesPage } from '../pages/TestCasesPage';
import { TestRunsPage } from '../pages/TestRunsPage';
import { TraceabilityPage } from '../pages/TraceabilityPage';

/**
 * Query defaults chosen for an internal tool: data is refetched when the user
 * comes back to the tab, but not on every mount, and a failed request is
 * retried once. Mutations never retry, because "create defect" twice is worse
 * than showing an error.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      { path: '/organizations', element: <OrganizationsPage /> },
      {
        element: <AppLayout />,
        children: [
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/requirements', element: <RequirementsPage /> },
          { path: '/test-cases', element: <TestCasesPage /> },
          { path: '/test-cases/:caseId', element: <TestCaseEditorPage /> },
          { path: '/test-runs', element: <TestRunsPage /> },
          { path: '/test-runs/:runId', element: <RunExecutionPage /> },
          { path: '/defects', element: <DefectsPage /> },
          { path: '/traceability', element: <TraceabilityPage /> },
          { path: '/members', element: <MembersPage /> },
          { path: '/project-access', element: <ProjectAccessPage /> },
          { path: '/profile', element: <ProfilePage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ProjectProvider>
          <RouterProvider router={router} />
        </ProjectProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
