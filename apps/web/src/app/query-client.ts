import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/http-client';

/** Every cached list of projects, whichever screen fetched it. */
const PROJECT_LIST_KEYS = [['projects'], ['projects-page']] as const;

/**
 * Query defaults chosen for an internal tool: data is refetched when the user
 * comes back to the tab, but not on every mount, and a failed request is
 * retried once. Mutations never retry, because "create defect" twice is worse
 * than showing an error.
 *
 * A 404 is what the API answers for a project the caller can no longer see,
 * so it also refetches the project lists: a project whose grant was revoked
 * drops out of the selector instead of staying cached until the next login.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!(error instanceof ApiError) || error.status !== 404) {
          return;
        }
        for (const queryKey of PROJECT_LIST_KEYS) {
          // A failing list is not refetched by its own error, or it would loop.
          if (query.queryKey[0] !== queryKey[0]) {
            void client.invalidateQueries({ queryKey });
          }
        }
      },
    }),
    defaultOptions: {
      queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: true },
      mutations: { retry: 0 },
    },
  });
  return client;
}
