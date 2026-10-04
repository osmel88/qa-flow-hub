import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ConfigurableIntegrationProvider,
  UpsertIntegrationInput,
  integrationProviderSchema,
  upsertIntegrationSchema,
} from '@qa-flow-hub/shared';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { IntegrationSettingsService } from './integration-settings.service';

/**
 * Organization-scoped, so deliberately *not* `@ProjectScoped()`: an integration
 * is configured once for the whole organization, and the roles guard can decide
 * on its own with the active organization from `X-Organization-Id`.
 *
 * Writes are limited to owners and admins. The roadmap's real gate is the
 * `integrations.manage` permission from S2-F8; until that exists, the two roles
 * that can already change organization-wide settings are the closest honest
 * approximation. Reads stay open to any member: knowing that Jira is configured
 * is not sensitive, and the response carries no credential.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('integrations')
export class IntegrationSettingsController {
  constructor(private readonly integrations: IntegrationSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Every configurable integration of the active organization' })
  list() {
    return this.integrations.list();
  }

  @Get(':provider')
  @ApiOperation({ summary: 'One integration, configured or not' })
  findOne(@Param('provider') provider: string) {
    return this.integrations.findOne(this.parseProvider(provider));
  }

  @RequirePermission('integrations.manage')
  @Put(':provider')
  @ApiOperation({ summary: 'Create or update the non-sensitive configuration of an integration' })
  upsert(
    @Param('provider') provider: string,
    @Body(zodBody(upsertIntegrationSchema)) body: UpsertIntegrationInput,
  ) {
    return this.integrations.upsert(this.parseProvider(provider), body);
  }

  @RequirePermission('integrations.manage')
  @Post(':provider/connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enable a configured integration' })
  connect(@Param('provider') provider: string) {
    return this.integrations.connect(this.parseProvider(provider));
  }

  @RequirePermission('integrations.manage')
  @Post(':provider/disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disable an integration, keeping its configuration and references' })
  disconnect(@Param('provider') provider: string) {
    return this.integrations.disconnect(this.parseProvider(provider));
  }

  @RequirePermission('integrations.manage')
  @Post(':provider/test-connection')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ask the provider whether it is reachable' })
  testConnection(@Param('provider') provider: string) {
    return this.integrations.testConnection(this.parseProvider(provider));
  }

  /**
   * Validating the path parameter through the same Zod enum the client uses
   * turns `/integrations/slack` into a 400 with a list of the accepted values,
   * instead of a 404 that looks like "your organization has no Slack yet".
   */
  private parseProvider(provider: string): ConfigurableIntegrationProvider {
    return zodBody(integrationProviderSchema).transform(provider, { type: 'param' });
  }
}
