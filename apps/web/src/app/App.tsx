import { QueryClientProvider } from '@tanstack/react-query';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { AppLayout } from '../components/AppLayout';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { ProjectProvider } from '../project/project-context';
import { BillingPage } from '../pages/BillingPage';
import { DashboardPage } from '../pages/DashboardPage';
import { MockCheckoutPage } from '../pages/MockCheckoutPage';
import { DefectsPage } from '../pages/DefectsPage';
import { ApiKeysPage } from '../pages/ApiKeysPage';
import { ReleaseDetailPage } from '../pages/ReleaseDetailPage';
import { ReleasesPage } from '../pages/ReleasesPage';
import { WorkItemDetailPage } from '../pages/WorkItemDetailPage';
import { WorkItemsPage } from '../pages/WorkItemsPage';
import { BacklogPage } from '../pages/BacklogPage';
import { HierarchyPage } from '../pages/HierarchyPage';
import { CustomizationPage } from '../pages/CustomizationPage';
import { ImportPage } from '../pages/ImportPage';
import { PrintableMatrixPage } from '../pages/PrintableMatrixPage';
import { PrintableRunPage } from '../pages/PrintableRunPage';
import { IntegrationsPage } from '../pages/IntegrationsPage';
import { LoginPage } from '../pages/LoginPage';
import { MembersPage } from '../pages/MembersPage';
import { NotificationsPage } from '../pages/NotificationsPage';
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
import { ExternalTraceabilityPage } from '../pages/ExternalTraceabilityPage';
import { TraceabilityPage } from '../pages/TraceabilityPage';
import { createQueryClient } from './query-client';

export const queryClient = createQueryClient();

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      { path: '/organizations', element: <OrganizationsPage /> },
      { path: '/print/traceability', element: <PrintableMatrixPage /> },
      { path: '/print/test-runs/:runId', element: <PrintableRunPage /> },
      {
        element: <AppLayout />,
        children: [
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/requirements', element: <RequirementsPage /> },
          { path: '/backlog', element: <BacklogPage /> },
          { path: '/hierarchy', element: <HierarchyPage /> },
          { path: '/work-items', element: <WorkItemsPage /> },
          { path: '/work-items/:workItemId', element: <WorkItemDetailPage /> },
          { path: '/test-cases', element: <TestCasesPage /> },
          { path: '/test-cases/:caseId', element: <TestCaseEditorPage /> },
          { path: '/imports', element: <ImportPage /> },
          { path: '/api-keys', element: <ApiKeysPage /> },
          { path: '/releases', element: <ReleasesPage /> },
          { path: '/customization', element: <CustomizationPage /> },
          { path: '/releases/:releaseId', element: <ReleaseDetailPage /> },
          { path: '/test-runs', element: <TestRunsPage /> },
          { path: '/test-runs/:runId', element: <RunExecutionPage /> },
          { path: '/defects', element: <DefectsPage /> },
          { path: '/traceability', element: <TraceabilityPage /> },
          { path: '/external-traceability', element: <ExternalTraceabilityPage /> },
          { path: '/members', element: <MembersPage /> },
          { path: '/project-access', element: <ProjectAccessPage /> },
          { path: '/settings/integrations', element: <IntegrationsPage /> },
          { path: '/notifications', element: <NotificationsPage /> },
          { path: '/profile', element: <ProfilePage /> },
          { path: '/billing', element: <BillingPage /> },
          { path: '/billing/checkout/:sessionId', element: <MockCheckoutPage /> },
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
