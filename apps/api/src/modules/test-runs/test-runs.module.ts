import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsModule } from '../projects/projects.module';
import { ReleasesModule } from '../releases/releases.module';
import { TraceabilityLinksModule } from '../traceability/traceability-links.module';
import { TestRunsController } from './test-runs.controller';
import { TestRunsRepository } from './test-runs.repository';
import { TestRunsService } from './test-runs.service';

@Module({
  imports: [ProjectsModule, OrganizationsModule, TraceabilityLinksModule, ReleasesModule],
  controllers: [TestRunsController],
  providers: [TestRunsService, TestRunsRepository],
  exports: [TestRunsService, TestRunsRepository],
})
export class TestRunsModule {}
