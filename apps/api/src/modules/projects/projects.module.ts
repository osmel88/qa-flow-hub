import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectAccessService } from './project-access.service';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersRepository } from './project-members.repository';
import { ProjectMembersService } from './project-members.service';
import { ProjectsController } from './projects.controller';
import { ProjectsRepository } from './projects.repository';
import { ProjectsService } from './projects.service';

@Module({
  // Imported for `OrganizationMembersRepository`: a project grant narrows an
  // organization role, so the organization membership is what it validates
  // against. The dependency stays one-directional — organizations know nothing
  // about projects.
  imports: [OrganizationsModule],
  controllers: [ProjectsController, ProjectMembersController],
  providers: [
    ProjectsService,
    ProjectsRepository,
    ProjectAccessService,
    ProjectMembersService,
    ProjectMembersRepository,
  ],
  // Exported because later modules (requirements, suites, runs) need the
  // repository to reserve human-readable keys inside their own transactions,
  // and `ProjectAccessService` to check the role that applies in the project
  // the entity they are touching belongs to.
  exports: [ProjectsService, ProjectsRepository, ProjectAccessService],
})
export class ProjectsModule {}
