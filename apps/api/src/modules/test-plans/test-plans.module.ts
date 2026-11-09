import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TestCyclesController } from './test-cycles.controller';
import { TestCyclesRepository } from './test-cycles.repository';
import { TestCyclesService } from './test-cycles.service';
import { TestPlansController } from './test-plans.controller';
import { TestPlansRepository } from './test-plans.repository';
import { TestPlansService } from './test-plans.service';

@Module({
  imports: [ProjectsModule],
  controllers: [TestPlansController, TestCyclesController],
  providers: [TestPlansService, TestPlansRepository, TestCyclesService, TestCyclesRepository],
})
export class TestPlansModule {}
