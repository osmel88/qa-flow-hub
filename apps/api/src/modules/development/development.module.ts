import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ReleasesModule } from '../releases/releases.module';
import { BuildsController } from './builds.controller';
import { BuildsService } from './builds.service';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import {
  DevelopmentArtifactsController,
  WorkItemDevelopmentController,
} from './development.controller';
import { DevelopmentRepository } from './development.repository';
import { DevelopmentService } from './development.service';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService } from './environments.service';

/** Branches, commits, pull requests, builds and deployments of work items (S5-F1). */
@Module({
  imports: [ProjectsModule, ReleasesModule],
  controllers: [
    DevelopmentArtifactsController,
    WorkItemDevelopmentController,
    BuildsController,
    DeploymentsController,
    EnvironmentsController,
  ],
  providers: [
    DevelopmentService,
    DevelopmentRepository,
    BuildsService,
    DeploymentsService,
    EnvironmentsService,
  ],
  exports: [DevelopmentService],
})
export class DevelopmentModule {}
