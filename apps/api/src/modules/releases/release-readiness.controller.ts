import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ReleaseReadinessService } from './release-readiness.service';

@ApiTags('releases')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('releases')
export class ReleaseReadinessController {
  constructor(private readonly readiness: ReleaseReadinessService) {}

  @RequirePermission('analytics.read')
  @Get(':id/readiness')
  @ApiOperation({
    summary: 'Release readiness report: GO / GO WITH RISKS / NO-GO / INSUFFICIENT DATA',
    description:
      'Derived on every read from quality gates, runs, plans, cycles, defects, requirement coverage, flaky detection and exploratory sessions. Nothing is stored.',
  })
  get(@Param('id') id: string) {
    return this.readiness.get(id);
  }
}
