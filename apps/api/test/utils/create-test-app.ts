import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/errors/all-exceptions.filter';

/**
 * Boots the real application for integration tests.
 *
 * It mirrors `src/main.ts` on purpose: global prefix, versioning and the
 * exception filter are part of the contract under test. A test app that skips
 * them would pass while production returns 404s.
 */
export async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });

  // Registered in main.ts too: without it, `request.cookies` is undefined and
  // the refresh cookie tests would fail for the wrong reason.
  await app.register(import('@fastify/cookie'));

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
