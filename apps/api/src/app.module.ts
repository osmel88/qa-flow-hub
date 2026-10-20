import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DomainEventsModule } from './events/domain-events.module';
import { AuditModule } from './modules/audit/audit.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DefectsModule } from './modules/defects/defects.module';
import { HealthModule } from './modules/health/health.module';
import { ExportsModule } from './modules/exports/exports.module';
import { AutomationModule } from './modules/automation/automation.module';
import { ReleasesModule } from './modules/releases/releases.module';
import { ImportsModule } from './modules/imports/imports.module';
import { SecretsModule } from './secrets/secrets.module';
import { IntegrationSettingsModule } from './modules/integrations/integration-settings.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RequirementsModule } from './modules/requirements/requirements.module';
import { TestDesignModule } from './modules/test-design/test-design.module';
import { TestRunsModule } from './modules/test-runs/test-runs.module';
import { TraceabilityModule } from './modules/traceability/traceability.module';

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
    DomainEventsModule,
    AuditModule,
    HealthModule,
    SecretsModule,
    AuthModule,
    OrganizationsModule,
    ProjectsModule,
    RequirementsModule,
    TestDesignModule,
    TestRunsModule,
    DefectsModule,
    TraceabilityModule,
    DashboardModule,
    IntegrationsModule,
    BillingModule,
    IntegrationSettingsModule,
    NotificationsModule,
    AttachmentsModule,
    ImportsModule,
    AutomationModule,
    ReleasesModule,
    ExportsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the health probe: a request without a context is
    // a request whose logs cannot be correlated.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
