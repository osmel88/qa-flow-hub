import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RequirementsModule } from './modules/requirements/requirements.module';
import { TestDesignModule } from './modules/test-design/test-design.module';

/**
 * Composition root of the modular monolith.
 *
 * Feature modules are registered here and nowhere else, which makes the module
 * graph readable at a glance and keeps cross-module imports honest: if a module
 * needs another module's data, it imports that module and uses its public
 * service, instead of reaching into its repository.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    // In-process event bus. Audit and future integration side effects subscribe
    // to domain events instead of being called inline from services.
    EventEmitterModule.forRoot({ global: true, wildcard: true, verboseMemoryLeak: true }),
    AuditModule,
    HealthModule,
    AuthModule,
    OrganizationsModule,
    ProjectsModule,
    RequirementsModule,
    TestDesignModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the health probe: a request without a context is
    // a request whose logs cannot be correlated.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
