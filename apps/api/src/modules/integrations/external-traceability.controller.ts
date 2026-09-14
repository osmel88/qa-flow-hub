import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ExternalTraceabilityQuery,
  VerifyExternalTraceabilityBody,
  externalTraceabilityQuerySchema,
  verifyExternalTraceabilityBodySchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExternalTraceabilityService } from './external-traceability.service';

/**
 * Consolidated view of a project's links into every provider.
 *
 * Lives under `/integrations/traceability` and not under `/traceability`: that
 * controller is the internal Requirement ↔ TestCase matrix and the two must not
 * be confused, in the URL any more than in the schema. Reading is open to any
 * project member, like the matrix; verifying talks to the providers and writes
 * to the connections, so it takes the roles that may sync.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('integrations/traceability')
export class ExternalTraceabilityController {
  constructor(private readonly traceability: ExternalTraceabilityService) {}

  @ProjectScoped()
  @Get()
  @ApiOperation({ summary: 'External references of a project with their derived sync status' })
  list(@Query(zodQuery(externalTraceabilityQuerySchema)) query: ExternalTraceabilityQuery) {
    return this.traceability.list(query);
  }

  @ProjectScoped()
  @Roles('organization_owner', 'organization_admin', 'project_manager', 'qa_lead')
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ask each provider whether the external objects still exist' })
  verify(
    @Body(zodBody(verifyExternalTraceabilityBodySchema)) body: VerifyExternalTraceabilityBody,
  ) {
    return this.traceability.verify(body);
  }
}
