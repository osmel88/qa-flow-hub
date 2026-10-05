import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ProxyTrust, configureApp, createFastifyAdapter } from './bootstrap/configure-app';
import { AppConfigService } from './config/app-config.service';
import { TenantContextService } from './database/tenant-context.service';
import { AppLifecycleService } from './modules/health/app-lifecycle.service';
import { createAppLogger } from './observability/app-logger';
import { setupSwagger } from './swagger';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const proxyTrust = new ProxyTrust();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(proxyTrust),
    // Buffered until the configured logger is installed, so even the module
    // initialisation lines come out in the production format.
    { bufferLogs: true },
  );

  const config = app.get(AppConfigService);
  const tenant = app.get(TenantContextService);
  app.useLogger(
    createAppLogger({
      format: config.logFormat,
      level: config.logLevel,
      requestId: () => tenant.requestId,
    }),
  );

  await configureApp(app, proxyTrust);

  if (config.swaggerEnabled) {
    setupSwagger(app);
  }

  // `listen` runs the bootstrap hooks: an unsafe database role or a broken
  // connection fails here, before the port is open.
  await app.listen({ port: config.port, host: config.host });
  installGracefulShutdown(app, config, app.get(AppLifecycleService));

  logger.log(`API listening on http://${config.host}:${config.port}/${config.apiPrefix}/v1`);
  if (config.swaggerEnabled) {
    logger.log(`OpenAPI UI on http://${config.host}:${config.port}/docs`);
  }
}

/**
 * SIGTERM is "stop taking new work", not "die now". Readiness turns 503 at
 * once, the listener stays open for `SHUTDOWN_GRACE_MS` while the load
 * balancer notices and in-flight requests finish, and only then Nest closes:
 * the HTTP server, then the database pool. A second signal is ignored; the
 * orchestrator's own kill timeout is the backstop.
 *
 * This replaces `enableShutdownHooks()`, whose listener would close the
 * application immediately and skip the drain.
 */
function installGracefulShutdown(
  app: NestFastifyApplication,
  config: AppConfigService,
  lifecycle: AppLifecycleService,
): void {
  const shutdown = (signal: NodeJS.Signals): void => {
    if (lifecycle.draining) {
      return;
    }
    lifecycle.beginDraining();
    logger.log({ msg: 'shutdown requested, draining', signal, graceMs: config.shutdownGraceMs });

    setTimeout(() => {
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error(
            { msg: 'shutdown failed' },
            error instanceof Error ? error.stack : undefined,
          );
          process.exit(1);
        },
      );
    }, config.shutdownGraceMs);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

bootstrap().catch((error: unknown) => {
  // The configured logger may not exist yet: write the reason plainly.
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
