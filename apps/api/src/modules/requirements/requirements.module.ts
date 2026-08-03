import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { RequirementsController } from './requirements.controller';
import { RequirementsRepository } from './requirements.repository';
import { RequirementsService } from './requirements.service';

@Module({
  // Imported for `ProjectsRepository.nextKey`, which reserves the readable key
  // inside this module's transaction.
  imports: [ProjectsModule],
  controllers: [RequirementsController],
  providers: [RequirementsService, RequirementsRepository],
  exports: [RequirementsService, RequirementsRepository],
})
export class RequirementsModule {}
