import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';

/**
 * A transactional Prisma client. Every repository method accepts one of these
 * so that a service can run several repository calls inside a single
 * transaction without the repositories knowing about it.
 */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      datasources: { db: { url: config.databaseUrl } },
      log: config.isProduction
        ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
        : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `work` inside a database transaction.
   *
   * Business operations that touch more than one table go through here, not
   * because transactions are elegant but because half of "create a defect from
   * a failed result" is worse than none of it.
   */
  runInTransaction<T>(
    work: (tx: PrismaTransaction) => Promise<T>,
    options?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return this.$transaction(work, {
      timeout: options?.timeoutMs ?? 10_000,
      ...(options?.isolationLevel === undefined
        ? {}
        : { isolationLevel: options.isolationLevel }),
    });
  }

  /**
   * Deletes every row from every table. Used only by the integration test
   * harness; guarded so that a misconfigured DATABASE_URL cannot wipe a real
   * database.
   */
  async truncateAllTables(): Promise<void> {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error('truncateAllTables() is only available when NODE_ENV=test');
    }

    const tables = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;

    if (tables.length === 0) {
      return;
    }

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    // `audit_logs` refuses UPDATE, DELETE and TRUNCATE in the database itself,
    // so the harness has to lift that guard for the length of the wipe. It is
    // the table owner and can, which is exactly the residual weakness the debt
    // entry describes: the strong version of this needs a role that does not own
    // the table.
    await this.$executeRawUnsafe(`ALTER TABLE "public"."audit_logs" DISABLE TRIGGER USER`);
    try {
      await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await this.$executeRawUnsafe(`ALTER TABLE "public"."audit_logs" ENABLE TRIGGER USER`);
    }
  }
}
