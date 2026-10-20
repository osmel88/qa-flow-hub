import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { NotificationsService } from './notifications.service';

/**
 * The in-process scheduler of the notification outbox. Every API replica runs
 * one; they never deliver the same row twice because each pass leases its
 * rows with `FOR UPDATE SKIP LOCKED` in the database, not in memory.
 *
 * A tick that is still running when the next one fires is skipped rather than
 * overlapped, so a slow provider stretches the interval instead of piling up
 * concurrent passes.
 */
@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const { workerEnabled, workerIntervalMs } = this.config.notifications;
    if (!workerEnabled) return;
    this.timer = setInterval(() => void this.tick(), workerIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.notifications.drainOutbox();
      if (result.claimed > 0) {
        this.logger.log(
          `Outbox pass: claimed=${result.claimed} sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `Outbox pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
