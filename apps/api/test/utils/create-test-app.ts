import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import type { Env } from '../../src/config/env.schema';
import { AllExceptionsFilter } from '../../src/errors/all-exceptions.filter';

/**
 * Boots the real application for integration tests.
 *
 * It mirrors `src/main.ts` on purpose: global prefix, versioning and the
 * exception filter are part of the contract under test. A test app that skips
 * them would pass while production returns 404s.
 */
export async function createTestApp(
  options: { databaseUrl?: string } = {},
): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  // The RLS suite boots the API as the runtime role, the way production runs
  // it. Only the connection string changes; every other setting is the
  // validated environment.
  if (options.databaseUrl !== undefined) {
    const databaseUrl = options.databaseUrl;
    class RuntimeRoleConfigService extends AppConfigService {
      override get databaseUrl(): string {
        return databaseUrl;
      }
    }
    builder.overrideProvider(AppConfigService).useFactory({
      inject: [ConfigService],
      factory: (config: ConfigService<Env, true>): AppConfigService =>
        new RuntimeRoleConfigService(config),
    });
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });

  // Registered in main.ts too: without it, `request.cookies` is undefined and
  // the refresh cookie tests would fail for the wrong reason.
  await app.register(import('@fastify/cookie'));

  // Same options as main.ts: the 413 path depends on truncation, not throwing.
  const config = app.get(AppConfigService);
  await app.register(import('@fastify/multipart'), {
    throwFileSizeLimit: false,
    limits: { files: 1, fields: 4, fileSize: config.storage.maxSizeBytes },
  });

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
