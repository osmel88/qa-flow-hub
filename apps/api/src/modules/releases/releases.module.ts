import { RequirementLinksModule } from '../requirement-links/requirement-links.module';
import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { QualityGatesController, ReleaseQualityGatesController } from './quality-gates.controller';
import { QualityGatesRepository } from './quality-gates.repository';
import { QualityGatesService } from './quality-gates.service';
import { ReleasePipelineService } from './release-pipeline.service';
import { ReleasesController } from './releases.controller';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

/** Releases of a project and the runs that point at them (S3-F4). */
@Module({
  imports: [ProjectsModule, RequirementLinksModule],
  controllers: [ReleasesController, QualityGatesController, ReleaseQualityGatesController],
  providers: [
    ReleasesService,
    ReleasesRepository,
    ReleasePipelineService,
    QualityGatesService,
    QualityGatesRepository,
  ],
  exports: [ReleasesService, QualityGatesService],
})
export class ReleasesModule {}
