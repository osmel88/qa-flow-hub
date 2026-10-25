import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsModule } from '../projects/projects.module';
import { ReleasesModule } from '../releases/releases.module';
import { WorkItemsController } from './work-items.controller';
import { WorkItemsRepository } from './work-items.repository';
import { WorkItemsService } from './work-items.service';

/** The backlog of a project: epics down to tasks (S4-F1). */
@Module({
  imports: [ProjectsModule, OrganizationsModule, ReleasesModule],
  controllers: [WorkItemsController],
  providers: [WorkItemsService, WorkItemsRepository],
  exports: [WorkItemsService],
})
export class WorkItemsModule {}
