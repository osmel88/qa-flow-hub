import { Module } from '@nestjs/common';
import { DevelopmentModule } from '../development/development.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsModule } from '../projects/projects.module';
import { ReleasesModule } from '../releases/releases.module';
import { RequirementLinksModule } from '../requirement-links/requirement-links.module';
import { BoardCardsService } from './board-cards';
import { BacklogController, WorkItemsController } from './work-items.controller';
import { WorkItemsRepository } from './work-items.repository';
import { WorkItemsService } from './work-items.service';

/** The backlog of a project: epics down to tasks (S4-F1). */
@Module({
  imports: [
    ProjectsModule,
    OrganizationsModule,
    ReleasesModule,
    RequirementLinksModule,
    DevelopmentModule,
  ],
  controllers: [WorkItemsController, BacklogController],
  providers: [WorkItemsService, WorkItemsRepository, BoardCardsService],
  exports: [WorkItemsService, WorkItemsRepository, BoardCardsService],
})
export class WorkItemsModule {}
