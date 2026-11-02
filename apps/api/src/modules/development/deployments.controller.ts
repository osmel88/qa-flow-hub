import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateDeploymentInput,
  DeploymentMetricsQuery,
  ListDeploymentsQuery,
  RollbackDeploymentInput,
  TransitionDeploymentInput,
  UpdateDeploymentInput,
  createDeploymentSchema,
  deploymentMetricsQuerySchema,
  listDeploymentsQuerySchema,
  rollbackDeploymentSchema,
  transitionDeploymentSchema,
  updateDeploymentSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { DeploymentsService } from './deployments.service';

/**
 * Deployments (S5-F5): reading needs `work_items.read`; reporting, moving,
 * editing and rolling back `work_items.write` (`work_items.manage` in a
 * protected environment, S6-F1).
 */
@ApiTags('deployments')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('deployments')
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @RequirePermission('work_items.write')
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Report a deployment; idempotent per provider and externalId' })
  create(
    @Body(zodBody(createDeploymentSchema)) body: CreateDeploymentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.deployments.create(body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({
    summary: 'Deployments filtered by status, environment, release, build or provider',
  })
  list(@Query(zodQuery(listDeploymentsQuerySchema)) query: ListDeploymentsQuery) {
    return this.deployments.list(query);
  }

  @RequirePermission('work_items.read')
  @Get('metrics')
  @ApiOperation({ summary: 'Success and failure rate, rollbacks and durations over a window' })
  metrics(@Query(zodQuery(deploymentMetricsQuerySchema)) query: DeploymentMetricsQuery) {
    return this.deployments.metrics(query);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({
    summary: 'A deployment with build, release, environment, rollbacks and work items',
  })
  get(@Param('id') id: string) {
    return this.deployments.get(id);
  }

  @RequirePermission('work_items.write')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit title, URL, release, metadata or log summary' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateDeploymentSchema)) body: UpdateDeploymentInput,
  ) {
    return this.deployments.update(id, body);
  }

  @RequirePermission('work_items.write')
  @Post(':id/transition')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a deployment: pending → deploying → succeeded/failed/cancelled' })
  transition(
    @Param('id') id: string,
    @Body(zodBody(transitionDeploymentSchema)) body: TransitionDeploymentInput,
  ) {
    return this.deployments.transition(id, body);
  }

  @RequirePermission('work_items.write')
  @Post(':id/rollback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Roll a succeeded deployment back (local/mock)' })
  rollback(
    @Param('id') id: string,
    @Body(zodBody(rollbackDeploymentSchema)) body: RollbackDeploymentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.deployments.rollback(id, body, user.userId);
  }
}
