import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { WorkItemsModule } from '../work-items/work-items.module';
import { KanbanController } from './kanban.controller';
import { KanbanRepository } from './kanban.repository';
import { KanbanService } from './kanban.service';

/** Kanban board of a project, independent from sprints (S4-F7). */
@Module({
  imports: [ProjectsModule, WorkItemsModule],
  controllers: [KanbanController],
  providers: [KanbanService, KanbanRepository],
})
export class KanbanModule {}
