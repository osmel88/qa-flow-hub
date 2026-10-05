import { Injectable } from '@nestjs/common';

/**
 * Whether the process is still accepting new work.
 *
 * Flipped once, by the SIGTERM handler in `main.ts`. From then on readiness
 * answers 503 so the load balancer takes the instance out of rotation, while
 * the listener stays open for the grace period and in-flight requests finish.
 */
@Injectable()
export class AppLifecycleService {
  private drainingSince: Date | null = null;

  get draining(): boolean {
    return this.drainingSince !== null;
  }

  beginDraining(): void {
    this.drainingSince ??= new Date();
  }
}
