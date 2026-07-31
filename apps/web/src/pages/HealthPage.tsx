import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/http-client';

interface HealthResponse {
  status: string;
  uptimeSeconds: number;
}

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/health', { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new ApiError(response.status, 'INTERNAL_ERROR', 'The API is not reachable');
  }
  return (await response.json()) as HealthResponse;
}

/**
 * Placeholder shell for phase 0. It exists to prove the full chain works —
 * browser, Vite proxy, Fastify, Nest — before any feature is written. The real
 * screens replace it in the frontend phase.
 */
export function HealthPage(): React.JSX.Element {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });

  return (
    <main className="page">
      <h1>qa-flow-hub</h1>
      <p className="muted">QA management platform — foundations</p>

      <section aria-labelledby="api-status-heading" className="card">
        <h2 id="api-status-heading">API status</h2>
        {isPending && <p role="status">Checking the API…</p>}
        {isError && (
          <p role="alert">
            The API is not reachable{error instanceof ApiError ? ` (${error.status})` : ''}.
          </p>
        )}
        {data && (
          <dl>
            <dt>Status</dt>
            <dd>{data.status}</dd>
            <dt>Uptime</dt>
            <dd>{data.uptimeSeconds}s</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
