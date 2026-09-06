import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { IntegrationSettingsController } from './integration-settings.controller';
import { IntegrationSettingsRepository } from './integration-settings.repository';
import { IntegrationSettingsService } from './integration-settings.service';

/**
 * Separate from `IntegrationsModule`, which owns the adapter *contracts and
 * implementations*: this module owns the configuration of connections and
 * consumes those adapters. Merging them would put the settings CRUD in the same
 * place as the provider clients, and every later phase adds one of each.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [IntegrationSettingsController],
  providers: [IntegrationSettingsService, IntegrationSettingsRepository],
  exports: [IntegrationSettingsService],
})
export class IntegrationSettingsModule {}
