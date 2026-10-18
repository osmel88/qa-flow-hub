import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http-client';
import { createQueryClient } from './query-client';

describe('createQueryClient', () => {
  const failWith = (client: ReturnType<typeof createQueryClient>, error: Error) =>
    client
      .fetchQuery({
        queryKey: ['requirements', 'p1'],
        queryFn: () => Promise.reject(error),
        retry: false,
      })
      .catch(() => undefined);

  it('refetches the project lists when a request answers 404', async () => {
    const client = createQueryClient();
    client.setQueryData(['projects', 'org-1'], { data: [{ id: 'p1' }] });
    client.setQueryData(['projects-page', {}], { data: [{ id: 'p1' }] });

    await failWith(client, new ApiError(404, 'NOT_FOUND', 'Project not found'));

    expect(client.getQueryState(['projects', 'org-1'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['projects-page', {}])?.isInvalidated).toBe(true);
  });

  it('leaves the project lists alone for any other error', async () => {
    const client = createQueryClient();
    client.setQueryData(['projects', 'org-1'], { data: [{ id: 'p1' }] });

    await failWith(client, new ApiError(403, 'FORBIDDEN', 'Not allowed'));
    await failWith(client, new Error('network'));

    expect(client.getQueryState(['projects', 'org-1'])?.isInvalidated).toBe(false);
  });
});
