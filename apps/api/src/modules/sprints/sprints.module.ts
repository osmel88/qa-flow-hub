import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { SprintsController } from './sprints.controller';
import { SprintsRepository } from './sprints.repository';
import { SprintsService } from './sprints.service';

/** Sprints of a project and their backlog (S4-F5). */
@Module({
  imports: [ProjectsModule],
  controllers: [SprintsController],
  providers: [SprintsService, SprintsRepository],
  exports: [SprintsService],
})
export class SprintsModule {}
