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
import { Roles } from '../auth/decorators/roles.decorator';
import { TraceabilityService } from './traceability.service';

const LINKERS = [
  'organization_owner',
  'organization_admin',
  'project_manager',
  'qa_lead',
  'tester',
] as const;

@ApiTags('traceability')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('traceability')
export class TraceabilityController {
  constructor(private readonly traceability: TraceabilityService) {}

  @Roles(...LINKERS)
  @Post('links')
  @ApiOperation({ summary: 'Link two entities' })
  createLink(
    @Body(zodBody(createTraceLinkSchema)) body: CreateTraceLinkInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.traceability.createLink(body, user.userId);
  }

  @Get('links')
  @ApiOperation({ summary: 'Every link touching an entity, in either direction' })
  listLinks(@Query(zodQuery(listTraceLinksQuerySchema)) query: ListTraceLinksQuery) {
    return this.traceability.listLinks(query);
  }

  @Roles(...LINKERS)
  @Delete('links/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a link' })
  async removeLink(@Param('id') id: string): Promise<void> {
    await this.traceability.removeLink(id);
  }

  @Get('matrix')
  @ApiOperation({ summary: 'Requirement coverage matrix for a project' })
  matrix(@Query(zodQuery(traceabilityMatrixQuerySchema)) query: TraceabilityMatrixQuery) {
    return this.traceability.matrix(query);
  }
}
