import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { HealthPage } from '../pages/HealthPage';

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

const router = createBrowserRouter([{ path: '*', element: <HealthPage /> }]);

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
