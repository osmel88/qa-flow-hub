import { Module } from '@nestjs/common';
import { DefectsModule } from '../defects/defects.module';
import { ProjectsModule } from '../projects/projects.module';
import { TraceabilityController } from './traceability.controller';
import { TraceabilityRepository } from './traceability.repository';
import { TraceabilityService } from './traceability.service';

/**
 * Traceability reads across every other module, so it owns no entity of its
 * own: it holds the link table and a read repository, and depends on the
 * modules that own the things being linked.
 */
@Module({
  imports: [DefectsModule, ProjectsModule],
  controllers: [TraceabilityController],
  providers: [TraceabilityService, TraceabilityRepository],
  exports: [TraceabilityService, TraceabilityRepository],
})
export class TraceabilityModule {}
