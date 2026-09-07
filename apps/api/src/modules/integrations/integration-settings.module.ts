import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AuditModule } from '../audit/audit.module';
import { DefectsModule } from '../defects/defects.module';
import { ProjectsModule } from '../projects/projects.module';
import { RequirementsModule } from '../requirements/requirements.module';
import { TestDesignModule } from '../test-design/test-design.module';
import { TestRunsModule } from '../test-runs/test-runs.module';
import { ExternalReferencesRepository } from './external-references.repository';
import { IntegrationSettingsController } from './integration-settings.controller';
import { IntegrationSettingsRepository } from './integration-settings.repository';
import { IntegrationSettingsService } from './integration-settings.service';
import { JiraSyncController } from './jira-sync.controller';
import { JiraSyncService } from './jira-sync.service';
import { TestRailSyncController } from './testrail-sync.controller';
import { TestRailSyncService } from './testrail-sync.service';

/**
 * Separate from `IntegrationsModule`, which owns the adapter *contracts and
 * implementations*: this module owns the configuration of connections and
 * consumes those adapters. Merging them would put the settings CRUD in the same
 * place as the provider clients, and every later phase adds one of each.
 *
 * Synchronisation lives here too, and depends on the business modules rather
 * than the other way round: requirements and defects know nothing about Jira,
 * suites and runs know nothing about TestRail; each provider side reads them
 * through their exported repositories.
 */
@Module({
  imports: [
    IntegrationsModule,
    AuditModule,
    ProjectsModule,
    RequirementsModule,
    DefectsModule,
    TestDesignModule,
    TestRunsModule,
  ],
  controllers: [IntegrationSettingsController, JiraSyncController, TestRailSyncController],
  providers: [
    IntegrationSettingsService,
    IntegrationSettingsRepository,
    ExternalReferencesRepository,
    JiraSyncService,
    TestRailSyncService,
  ],
  exports: [IntegrationSettingsService, JiraSyncService, TestRailSyncService],
})
export class IntegrationSettingsModule {}
