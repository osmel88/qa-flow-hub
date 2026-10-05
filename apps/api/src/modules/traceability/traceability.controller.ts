import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateTraceLinkInput,
  ListTraceLinksQuery,
  TraceabilityMatrixQuery,
  createTraceLinkSchema,
  listTraceLinksQuerySchema,
  traceabilityMatrixQuerySchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { TraceabilityService } from './traceability.service';

@ApiTags('traceability')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('traceability')
export class TraceabilityController {
  constructor(private readonly traceability: TraceabilityService) {}

  @RequirePermission('traceability.manage')
  @Post('links')
  @ApiOperation({ summary: 'Link two entities' })
  createLink(
    @Body(zodBody(createTraceLinkSchema)) body: CreateTraceLinkInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.traceability.createLink(body, user.userId);
  }

  @RequirePermission('traceability.read')
  @Get('links')
  @ApiOperation({ summary: 'Every link touching an entity, in either direction' })
  listLinks(@Query(zodQuery(listTraceLinksQuerySchema)) query: ListTraceLinksQuery) {
    return this.traceability.listLinks(query);
  }

  @RequirePermission('traceability.manage')
  @Delete('links/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a link' })
  async removeLink(@Param('id') id: string): Promise<void> {
    await this.traceability.removeLink(id);
  }

  @RequirePermission('traceability.read')
  @Get('matrix')
  @ApiOperation({ summary: 'Requirement coverage matrix for a project' })
  matrix(@Query(zodQuery(traceabilityMatrixQuerySchema)) query: TraceabilityMatrixQuery) {
    return this.traceability.matrix(query);
  }
}
