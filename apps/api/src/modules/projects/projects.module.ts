import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsRepository } from './projects.repository';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsRepository],
  // Exported because later modules (requirements, suites, runs) need the
  // repository to reserve human-readable keys inside their own transactions.
  exports: [ProjectsService, ProjectsRepository],
})
export class ProjectsModule {}
