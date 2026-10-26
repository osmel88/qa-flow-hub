import { RequirementLinksModule } from '../requirement-links/requirement-links.module';
import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ReleasesController } from './releases.controller';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

/** Releases of a project and the runs that point at them (S3-F4). */
@Module({
  imports: [ProjectsModule, RequirementLinksModule],
  controllers: [ReleasesController],
  providers: [ReleasesService, ReleasesRepository],
  exports: [ReleasesService],
})
export class ReleasesModule {}
