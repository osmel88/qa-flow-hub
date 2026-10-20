import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TestRunsModule } from '../test-runs/test-runs.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';
import { IngestionController, IngestionReportsController } from './ingestion.controller';
import { IngestionRepository } from './ingestion.repository';
import { IngestionService } from './ingestion.service';

/** Project API keys and the CI endpoints that use them (S3-F3). */
@Module({
  imports: [ProjectsModule, TestRunsModule],
  controllers: [ApiKeysController, IngestionController, IngestionReportsController],
  providers: [ApiKeysService, ApiKeysRepository, IngestionService, IngestionRepository],
})
export class AutomationModule {}
