import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TestPlansController } from './test-plans.controller';
import { TestPlansRepository } from './test-plans.repository';
import { TestPlansService } from './test-plans.service';

@Module({
  imports: [ProjectsModule],
  controllers: [TestPlansController],
  providers: [TestPlansService, TestPlansRepository],
})
export class TestPlansModule {}
