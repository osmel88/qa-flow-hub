import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TraceabilityModule } from '../traceability/traceability.module';
import { ExportsController } from './exports.controller';
import { ExportsRepository } from './exports.repository';
import { ExportsService } from './exports.service';

@Module({
  imports: [ProjectsModule, TraceabilityModule],
  controllers: [ExportsController],
  providers: [ExportsService, ExportsRepository],
})
export class ExportsModule {}
