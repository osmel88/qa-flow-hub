import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import {
  RequirementWorkItemsController,
  WorkItemRequirementsController,
} from './requirement-links.controller';
import { RequirementLinksRepository } from './requirement-links.repository';
import { RequirementLinksService } from './requirement-links.service';

/** Requirement ↔ work item `implements` links (S4-F4). */
@Module({
  imports: [ProjectsModule],
  controllers: [RequirementWorkItemsController, WorkItemRequirementsController],
  providers: [RequirementLinksService, RequirementLinksRepository],
  exports: [RequirementLinksService],
})
export class RequirementLinksModule {}
