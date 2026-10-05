import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateAfterResult } from './run-execution-cache';

describe('invalidateAfterResult', () => {
  it('marks the matrix and the dashboards stale, not just the run', async () => {
    const client = new QueryClient();
    const keys = [
      ['run', 'run_1'],
      ['run-cases', 'run_1'],
      ['matrix', 'proj_1', false],
      ['analytics', 'org_1', 'proj_1', 'summary'],
    ];
    for (const key of keys) {
      client.setQueryData(key, { cached: true });
    }
    client.setQueryData(['run', 'run_2'], { cached: true });

    await invalidateAfterResult(client, 'run_1');

    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    expect(client.getQueryState(['run', 'run_2'])?.isInvalidated).toBe(false);
  });
});
