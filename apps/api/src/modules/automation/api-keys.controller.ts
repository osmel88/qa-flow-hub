import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateApiKeyInput, createApiKeySchema } from '@qa-flow-hub/shared';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ApiKeysService } from './api-keys.service';

@ApiTags('automation')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('projects/:projectId/api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @RequirePermission('api_keys.manage')
  @Get()
  @ApiOperation({ summary: 'API keys of the project (never their secret)' })
  list(@Param('projectId') projectId: string) {
    return this.keys.list(projectId);
  }

  @RequirePermission('api_keys.manage')
  @Post()
  @ApiOperation({ summary: 'Create an API key; the token is returned once and never again' })
  create(
    @Param('projectId') projectId: string,
    @Body(zodBody(createApiKeySchema)) body: CreateApiKeyInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.keys.create(projectId, body, user.userId);
  }

  @RequirePermission('api_keys.manage')
  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke an API key; effective for the very next request' })
  revoke(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.keys.revoke(projectId, id, user.userId);
  }
}
