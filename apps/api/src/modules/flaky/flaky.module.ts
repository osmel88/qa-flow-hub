import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { FlakyController } from './flaky.controller';
import { FlakyRepository } from './flaky.repository';
import { FlakyService } from './flaky.service';

@Module({
  imports: [ProjectsModule],
  controllers: [FlakyController],
  providers: [FlakyService, FlakyRepository],
})
export class FlakyModule {}
