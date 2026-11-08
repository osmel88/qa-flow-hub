import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateQualityGateInput,
  EvaluateQualityGatesQuery,
  ListQualityGatesQuery,
  OverrideQualityGatesInput,
  UpdateQualityGateInput,
  createQualityGateSchema,
  evaluateQualityGatesQuerySchema,
  listQualityGatesQuerySchema,
  overrideQualityGatesSchema,
  updateQualityGateSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { QualityGatesService } from './quality-gates.service';

/**
 * Quality gates (S6-F3): reading and evaluating need `releases.read`;
 * configuring `releases.manage`; overriding `quality_gates.override`.
 */
@ApiTags('quality-gates')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('quality-gates')
export class QualityGatesController {
  constructor(private readonly gates: QualityGatesService) {}

  @RequirePermission('releases.read')
  @Get()
  @ApiOperation({ summary: 'Quality gates of a project, optionally those of one environment' })
  list(@Query(zodQuery(listQualityGatesQuerySchema)) query: ListQualityGatesQuery) {
    return this.gates.list(query);
  }

  @RequirePermission('releases.read')
  @Get(':id')
  @ApiOperation({ summary: 'A quality gate and its rules' })
  get(@Param('id') id: string) {
    return this.gates.get(id);
  }

  @RequirePermission('releases.manage')
  @Post()
  @ApiOperation({ summary: 'Create a quality gate with one or more rules' })
  create(
    @Body(zodBody(createQualityGateSchema)) body: CreateQualityGateInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.gates.create(body, user.userId);
  }

  @RequirePermission('releases.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a quality gate; `rules` replaces every rule' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateQualityGateSchema)) body: UpdateQualityGateInput,
  ) {
    return this.gates.update(id, body);
  }

  @RequirePermission('releases.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a quality gate' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.gates.remove(id);
  }
}

@ApiTags('quality-gates')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('releases')
export class ReleaseQualityGatesController {
  constructor(private readonly gates: QualityGatesService) {}

  @RequirePermission('releases.read')
  @Get(':id/quality-gates')
  @ApiOperation({ summary: 'Evaluate the quality gates of a release against current data' })
  evaluate(
    @Param('id') id: string,
    @Query(zodQuery(evaluateQualityGatesQuerySchema)) query: EvaluateQualityGatesQuery,
  ) {
    return this.gates.evaluate(id, query);
  }

  @RequirePermission('quality_gates.override')
  @Post(':id/quality-gates/override')
  @HttpCode(201)
  @ApiOperation({ summary: 'Override failing required gates for one environment; reason required' })
  override(
    @Param('id') id: string,
    @Body(zodBody(overrideQualityGatesSchema)) body: OverrideQualityGatesInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.gates.override(id, body, user.userId);
  }
}
