import type { LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { ProxyTrust, configureApp, createFastifyAdapter } from '../../src/bootstrap/configure-app';
import { AppConfigService } from '../../src/config/app-config.service';
import type { Env } from '../../src/config/env.schema';

/** Settings a suite may change without touching the process environment. */
export interface TestAppOptions {
  /** The RLS suites boot the API as the runtime role, the way production runs it. */
  databaseUrl?: string;
  authRateLimit?: { max: number; windowMs: number };
  metrics?: { enabled: boolean; token: string | null };
  trustProxyHops?: number;
  billingWebhookRateLimitMax?: number;
  importRateLimitMax?: number;
  ingestion?: Partial<AppConfigService['ingestion']>;
  /** Receives the application's log lines; silent by default. */
  logger?: LoggerService;
}

/**
 * Boots the real application for integration tests.
 *
 * Plugins, hooks, prefix, versioning and the exception filter come from
 * `configureApp`, the same function `main.ts` calls: they are part of the
 * contract under test, and a test app assembled by hand would pass while
 * production returns 404s.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  // Only the overridden settings change; every other one is the validated
  // environment.
  class TestConfigService extends AppConfigService {
    override get databaseUrl(): string {
      return options.databaseUrl ?? super.databaseUrl;
    }
    override get authRateLimit(): { max: number; windowMs: number } {
      return options.authRateLimit ?? super.authRateLimit;
    }
    override get metrics(): { enabled: boolean; token: string | null } {
      return options.metrics ?? super.metrics;
    }
    override get trustProxyHops(): number {
      return options.trustProxyHops ?? super.trustProxyHops;
    }
    override get imports(): AppConfigService['imports'] {
      const imports = super.imports;
      return options.importRateLimitMax === undefined
        ? imports
        : { ...imports, rateLimitMax: options.importRateLimitMax };
    }
    override get ingestion(): AppConfigService['ingestion'] {
      return { ...super.ingestion, ...options.ingestion };
    }
    override get billing(): AppConfigService['billing'] {
      const billing = super.billing;
      return options.billingWebhookRateLimitMax === undefined
        ? billing
        : { ...billing, webhookRateLimitMax: options.billingWebhookRateLimitMax };
    }
  }
  builder.overrideProvider(AppConfigService).useFactory({
    inject: [ConfigService],
    factory: (config: ConfigService<Env, true>): AppConfigService => new TestConfigService(config),
  });

  const moduleRef = await builder.compile();

  const proxyTrust = new ProxyTrust();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(proxyTrust),
    { logger: false },
  );
  if (options.logger !== undefined) {
    app.useLogger(options.logger);
  }

  await configureApp(app, proxyTrust);

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
