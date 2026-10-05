import type { QueryClient } from '@tanstack/react-query';

/**
 * Everything a recorded verdict can change: the run itself, its cases and
 * results, the run list, the traceability matrix (last status, verification)
 * and the KPI dashboards built on the same results.
 */
export async function invalidateAfterResult(queryClient: QueryClient, runId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['run', runId] }),
    queryClient.invalidateQueries({ queryKey: ['run-cases', runId] }),
    queryClient.invalidateQueries({ queryKey: ['run-case-results', runId] }),
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['matrix'] }),
    queryClient.invalidateQueries({ queryKey: ['analytics'] }),
  ]);
}
