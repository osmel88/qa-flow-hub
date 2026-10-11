import { describe, expect, it } from 'vitest';
import { SnapshotRateLimitStore } from './rate-limit-store';

const incr = (
  store: SnapshotRateLimitStore,
  key: string,
  timeWindow: number,
): { current: number; ttl: number } => {
  let result: { current: number; ttl: number } | undefined;
  store.incr(key, (_error, value) => (result = value), timeWindow);
  if (result === undefined) {
    throw new Error('no result');
  }
  return result;
};

describe('SnapshotRateLimitStore', () => {
  it('reports each increment as it was, not the counter as it ends up', () => {
    const store = new SnapshotRateLimitStore({}, () => 1_000);
    const results = [incr(store, 'a', 60_000), incr(store, 'a', 60_000), incr(store, 'a', 60_000)];

    expect(results.map((result) => result.current)).toEqual([1, 2, 3]);
  });

  it('counts keys apart and restarts the window once it has elapsed', () => {
    let now = 0;
    const store = new SnapshotRateLimitStore({}, () => now);
    incr(store, 'a', 1_000);
    incr(store, 'a', 1_000);

    expect(incr(store, 'b', 1_000).current).toBe(1);
    now = 400;
    expect(incr(store, 'a', 1_000)).toEqual({ current: 3, ttl: 600 });
    now = 1_000;
    expect(incr(store, 'a', 1_000)).toEqual({ current: 1, ttl: 1_000 });
  });

  it('forgets the least recently seen client instead of growing without bound', () => {
    const store = new SnapshotRateLimitStore({}, () => 0);
    incr(store, 'first', 60_000);
    for (let index = 0; index < 5_000; index += 1) {
      incr(store, `client-${index}`, 60_000);
    }

    expect(incr(store, 'first', 60_000).current).toBe(1);
  });
});
