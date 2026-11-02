import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { BuildsController } from './builds.controller';
import { BuildsService } from './builds.service';
import { DeploymentsController, EnvironmentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import {
  DevelopmentArtifactsController,
  WorkItemDevelopmentController,
} from './development.controller';
import { DevelopmentRepository } from './development.repository';
import { DevelopmentService } from './development.service';

/** Branches, commits, pull requests, builds and deployments of work items (S5-F1). */
@Module({
  imports: [ProjectsModule],
  controllers: [
    DevelopmentArtifactsController,
    WorkItemDevelopmentController,
    BuildsController,
    DeploymentsController,
    EnvironmentsController,
  ],
  providers: [DevelopmentService, DevelopmentRepository, BuildsService, DeploymentsService],
  exports: [DevelopmentService],
})
export class DevelopmentModule {}
