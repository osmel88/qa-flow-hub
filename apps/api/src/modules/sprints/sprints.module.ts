import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { WorkItemsModule } from '../work-items/work-items.module';
import { SprintBoardService } from './sprint-board.service';
import { SprintsController } from './sprints.controller';
import { SprintsRepository } from './sprints.repository';
import { SprintsService } from './sprints.service';

/** Sprints of a project, their backlog (S4-F5) and their Scrum board (S4-F6). */
@Module({
  imports: [ProjectsModule, WorkItemsModule],
  controllers: [SprintsController],
  providers: [SprintsService, SprintBoardService, SprintsRepository],
  exports: [SprintsService],
})
export class SprintsModule {}
