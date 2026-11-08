import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RollbackEnvironmentInput, rollbackEnvironmentSchema } from '@qa-flow-hub/shared';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { DeploymentsService } from './deployments.service';

/**
 * Environment rollback (S6-F5): rolling back needs `work_items.write`
 * (`work_items.manage` when protected, `releases.emergency_rollback` for an
 * emergency); the history needs `work_items.read`.
 */
@ApiTags('environments')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('environments')
export class EnvironmentRollbacksController {
  constructor(private readonly deployments: DeploymentsService) {}

  @RequirePermission('work_items.write')
  @Post(':id/rollback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Roll the environment back to an earlier deployment (reason required)' })
  rollback(
    @Param('id') id: string,
    @Body(zodBody(rollbackEnvironmentSchema)) body: RollbackEnvironmentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.deployments.rollbackEnvironment(id, body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get(':id/rollbacks')
  @ApiOperation({ summary: 'Rollback history of an environment, newest first' })
  history(@Param('id') id: string) {
    return this.deployments.rollbackHistory(id);
  }
}
