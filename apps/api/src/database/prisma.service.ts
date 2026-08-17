import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { TenantContextService } from './tenant-context.service';

/**
 * A transactional Prisma client. Every repository method accepts one of these
 * so that a service can run several repository calls inside a single
 * transaction without the repositories knowing about it.
 */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Wraps a client so that every model operation announces the active
 * organization to PostgreSQL before running.
 *
 * Row Level Security reads `app.current_organization`, and the value has to be
 * set on the same connection as the query. Prisma pools connections, so setting
 * it "per request" outside a transaction would hand the setting to whichever
 * request borrowed the connection next — the one bug worse than no RLS, because
 * it leaks *between* tenants instead of failing. Hence the batch: `set_config`
 * with `TRUE` (transaction-local) and the query travel together, and the
 * setting dies with the transaction.
 *
 * When the request has no active organization (login, registration, accepting
 * an invitation) nothing is set, and the policies then match no row at all.
 * That is the intended answer: those flows only touch tables without RLS.
 */
function withRowLevelSecurity(client: PrismaClient, tenant: TenantContextService) {
  return client.$extends({
    name: 'row-level-security',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const organizationId = tenant.organizationId;

          if (organizationId === undefined) {
            return query(args);
          }

          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, TRUE)`,
            query(args) as Prisma.PrismaPromise<unknown>,
          ]);

          return result;
        },
      },
    },
  });
}

export type RlsPrismaClient = ReturnType<typeof withRowLevelSecurity>;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * The client every tenant-aware repository uses. Same API as this service;
   * the difference is invisible on purpose, so that no repository has to
   * remember to opt into the database-level guard.
   */
  readonly scoped: RlsPrismaClient;

  constructor(
    config: AppConfigService,
    private readonly tenant: TenantContextService,
  ) {
    super({
      datasources: { db: { url: config.databaseUrl } },
      log: config.isProduction
        ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
        : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
    });

    this.scoped = withRowLevelSecurity(this, this.tenant);
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
   *
   * It also sets `app.current_organization` once for the whole transaction, so
   * the statements inside it are subject to the same policies as a standalone
   * query.
   */
  runInTransaction<T>(
    work: (tx: PrismaTransaction) => Promise<T>,
    options?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    const organizationId = this.tenant.organizationId;

    return this.$transaction(
      async (tx) => {
        if (organizationId !== undefined) {
          await tx.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, TRUE)`;
        }

        return work(tx);
      },
      {
        timeout: options?.timeoutMs ?? 10_000,
        ...(options?.isolationLevel === undefined
          ? {}
          : { isolationLevel: options.isolationLevel }),
      },
    );
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
    // so the harness has to lift that guard for the length of the wipe. It runs
    // as the owner and can; the application role cannot, which is the whole
    // point of the split.
    await this.$executeRawUnsafe(`ALTER TABLE "public"."audit_logs" DISABLE TRIGGER USER`);
    try {
      await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await this.$executeRawUnsafe(`ALTER TABLE "public"."audit_logs" ENABLE TRIGGER USER`);
    }
  }
}
