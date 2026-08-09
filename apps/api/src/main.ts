import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { AllExceptionsFilter } from './errors/all-exceptions.filter';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    // Correlates every log line, audit row and error response of one request.
    genReqId: (request: IncomingMessage) =>
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);

  // Security headers first: they must be present even on responses produced by
  // plugins that run before the Nest router (rate limiting, for instance).
  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: config.isProduction ? undefined : false,
  });

  // Refresh tokens travel as an HttpOnly cookie; see RefreshCookieService.
  await app.register(import('@fastify/cookie'));

  await app.register(import('@fastify/cors'), {
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  await app.register(import('@fastify/rate-limit'), {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // In-process store. Documented limitation: with more than one API instance
    // the effective limit is `max * instances`. See docs/technical-debt.md.
  });

  app.setGlobalPrefix(config.apiPrefix, { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    setupSwagger(app);
  }

  await app.listen({ port: config.port, host: config.host });

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://${config.host}:${config.port}/${config.apiPrefix}/v1`);
  if (config.swaggerEnabled) {
    logger.log(`OpenAPI UI on http://${config.host}:${config.port}/docs`);
  }
}

void bootstrap();
