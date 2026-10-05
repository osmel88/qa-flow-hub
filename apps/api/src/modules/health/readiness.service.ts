import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { DatabaseRoleInspector } from '../../database/database-role.inspector';
import { PrismaService } from '../../database/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../../storage/storage-provider';
import { AppLifecycleService } from './app-lifecycle.service';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  durationMs: number;
}

export interface MigrationsCheckResult extends CheckResult {
  pending: number;
  failed: number;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready' | 'draining';
  checks: {
    database: CheckResult;
    migrations: MigrationsCheckResult;
    storage: CheckResult;
    databaseRole: CheckResult;
  };
}

/** A dependency slower than this is treated as down: a probe must answer fast. */
const CHECK_TIMEOUT_MS = 2_000;

/**
 * From `src/modules/health` or `dist/modules/health` up to `apps/api`. The
 * runtime image copies `apps/api/prisma`, so the list of migrations the code
 * expects travels with the code.
 */
const MIGRATIONS_DIR = resolve(__dirname, '../../../prisma/migrations');

/**
 * Readiness: can this instance serve a request right now?
 *
 * Unlike liveness it touches every dependency a request needs, and a failure
 * means "route traffic elsewhere", not "restart me". The report carries a
 * status per check and nothing else — no error text, host name or migration
 * name, because the endpoint is unauthenticated. The detail goes to the log.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  private expectedMigrations: readonly string[] | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly roleInspector: DatabaseRoleInspector,
    private readonly lifecycle: AppLifecycleService,
    private readonly config: AppConfigService,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, migrations, storage] = await Promise.all([
      this.timed('database', () => this.checkDatabase()),
      this.checkMigrations(),
      this.timed('storage', () => this.checkStorage()),
    ]);
    const databaseRole = this.checkDatabaseRole();

    const checks = { database, migrations, storage, databaseRole };
    const failing = Object.values(checks).some((check) => check.status === 'fail');

    return {
      status: this.lifecycle.draining ? 'draining' : failing ? 'not_ready' : 'ready',
      checks,
    };
  }

  private async checkDatabase(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  /** Writes, reads back and deletes a throwaway object. */
  private async checkStorage(): Promise<void> {
    const key = `health/readiness-${randomUUID()}.probe`;
    await this.storage.put(key, Readable.from([Buffer.from('ok')]), { contentType: 'text/plain' });
    try {
      if ((await this.storage.head(key)) === null) {
        throw new Error('probe object missing right after it was written');
      }
    } finally {
      await this.storage.delete(key);
    }
  }

  /**
   * Every migration shipped with the code must be applied, and none may be
   * half-applied. A database *ahead* of the code is fine: that is the normal
   * state during a rolling deploy of an expand-then-contract change.
   */
  private async checkMigrations(): Promise<MigrationsCheckResult> {
    const started = performance.now();
    try {
      const rows = await withTimeout(
        this.prisma.$queryRaw<
          Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
        >`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
      );
      const applied = new Set(
        rows
          .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
          .map((row) => row.migration_name),
      );
      const failed = rows.filter(
        (row) => row.finished_at === null && row.rolled_back_at === null,
      ).length;
      const pending = this.expected().filter((name) => !applied.has(name)).length;

      if (pending > 0 || failed > 0) {
        this.logger.warn({ msg: 'readiness check failed', check: 'migrations', pending, failed });
      }
      return {
        status: pending > 0 || failed > 0 ? 'fail' : 'ok',
        durationMs: elapsed(started),
        pending,
        failed,
      };
    } catch (error: unknown) {
      this.logFailure('migrations', error);
      return { status: 'fail', durationMs: elapsed(started), pending: 0, failed: 0 };
    }
  }

  /**
   * Inspected once at boot; the role of a connection string does not change
   * while the process runs. Unsafe is fatal at boot in production, so here it
   * can only be reached outside production, where it is a warning.
   */
  private checkDatabaseRole(): CheckResult {
    const status = this.roleInspector.status;
    const result: CheckStatus =
      status === 'safe' ? 'ok' : status === 'unsafe' && !this.config.isProduction ? 'warn' : 'fail';
    return { status: result, durationMs: 0 };
  }

  private expected(): readonly string[] {
    this.expectedMigrations ??= readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return this.expectedMigrations;
  }

  private async timed(name: string, work: () => Promise<void>): Promise<CheckResult> {
    const started = performance.now();
    try {
      await withTimeout(work());
      return { status: 'ok', durationMs: elapsed(started) };
    } catch (error: unknown) {
      this.logFailure(name, error);
      return { status: 'fail', durationMs: elapsed(started) };
    }
  }

  private logFailure(check: string, error: unknown): void {
    this.logger.warn({
      msg: 'readiness check failed',
      check,
      reason: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS} ms`)),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
