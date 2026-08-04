import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DashboardQuery,
  ListAuditQuery,
  dashboardQuerySchema,
  listAuditQuerySchema,
} from '@qa-flow-hub/shared';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Aggregated state of the organization or one project' })
  summary(@Query(zodQuery(dashboardQuerySchema)) query: DashboardQuery) {
    return this.dashboard.summary(query);
  }

  /** Who did what is management information, not everyday reading. */
  @Roles('organization_owner', 'organization_admin')
  @Get('audit-log')
  @ApiOperation({ summary: 'Read the audit trail' })
  audit(@Query(zodQuery(listAuditQuerySchema)) query: ListAuditQuery) {
    return this.dashboard.audit(query);
  }
}
