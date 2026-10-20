import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import type { NotificationsService } from './notifications.service';

const config = (workerEnabled: boolean): AppConfigService =>
  ({
    notifications: { workerEnabled, workerIntervalMs: 1_000 },
  }) as unknown as AppConfigService;

const service = (drain: () => Promise<unknown>): NotificationsService =>
  ({ drainOutbox: drain }) as unknown as NotificationsService;

afterEach(() => {
  vi.useRealTimers();
});

describe('NotificationOutboxWorker', () => {
  it('drains on its interval and stops on shutdown', async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => ({ claimed: 0, sent: 0, failed: 0, skipped: 0 }));
    const worker = new NotificationOutboxWorker(service(drain), config(true));
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(drain).toHaveBeenCalledTimes(3);
    worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('does not schedule anything when disabled', async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => ({ claimed: 0, sent: 0, failed: 0, skipped: 0 }));
    const worker = new NotificationOutboxWorker(service(drain), config(false));
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drain).not.toHaveBeenCalled();
  });

  it('never overlaps passes and survives a failing one', async () => {
    let release: () => void = () => undefined;
    const drain = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
          }),
      )
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
    const worker = new NotificationOutboxWorker(service(drain), config(false));
    const first = worker.tick();
    await worker.tick();
    expect(drain).toHaveBeenCalledTimes(1);
    release();
    await first;
    await expect(worker.tick()).resolves.toBeUndefined();
    await worker.tick();
    expect(drain).toHaveBeenCalledTimes(3);
  });
});
