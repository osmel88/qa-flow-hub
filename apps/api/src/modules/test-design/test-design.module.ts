import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TraceabilityLinksModule } from '../traceability/traceability-links.module';
import { TestDesignController } from './test-design.controller';
import { TestDesignRepository } from './test-design.repository';
import { TestDesignService } from './test-design.service';

@Module({
  imports: [ProjectsModule, TraceabilityLinksModule],
  controllers: [TestDesignController],
  providers: [TestDesignService, TestDesignRepository],
  exports: [TestDesignService, TestDesignRepository],
})
export class TestDesignModule {}
