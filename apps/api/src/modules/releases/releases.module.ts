import { RequirementLinksModule } from '../requirement-links/requirement-links.module';
import { Module } from '@nestjs/common';
import { FlakyModule } from '../flaky/flaky.module';
import { ProjectsModule } from '../projects/projects.module';
import { TestPlansModule } from '../test-plans/test-plans.module';
import { QualityGatesController, ReleaseQualityGatesController } from './quality-gates.controller';
import { QualityGatesRepository } from './quality-gates.repository';
import { QualityGatesService } from './quality-gates.service';
import {
  ReleaseApprovalRulesController,
  ReleaseApprovalsController,
} from './release-approvals.controller';
import { ReleaseApprovalsRepository } from './release-approvals.repository';
import { ReleaseApprovalsService } from './release-approvals.service';
import { ReleaseReadinessController } from './release-readiness.controller';
import { ReleaseReadinessRepository } from './release-readiness.repository';
import { ReleaseReadinessService } from './release-readiness.service';
import { ReleasePipelineService } from './release-pipeline.service';
import { ReleasesController } from './releases.controller';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

/** Releases of a project and the runs that point at them (S3-F4). */
@Module({
  imports: [ProjectsModule, RequirementLinksModule, TestPlansModule, FlakyModule],
  controllers: [
    ReleasesController,
    QualityGatesController,
    ReleaseQualityGatesController,
    ReleaseApprovalRulesController,
    ReleaseApprovalsController,
    ReleaseReadinessController,
  ],
  providers: [
    ReleasesService,
    ReleaseReadinessService,
    ReleaseReadinessRepository,
    ReleasesRepository,
    ReleasePipelineService,
    QualityGatesService,
    QualityGatesRepository,
    ReleaseApprovalsService,
    ReleaseApprovalsRepository,
  ],
  exports: [ReleasesService, QualityGatesService, ReleaseApprovalsService],
})
export class ReleasesModule {}
