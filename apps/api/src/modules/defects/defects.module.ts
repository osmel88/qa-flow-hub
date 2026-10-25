import { CustomizationModule } from '../customization/customization.module';
import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsModule } from '../projects/projects.module';
import { TraceabilityLinksModule } from '../traceability/traceability-links.module';
import { DefectsController } from './defects.controller';
import { DefectsRepository } from './defects.repository';
import { DefectsService } from './defects.service';

@Module({
  imports: [CustomizationModule, ProjectsModule, OrganizationsModule, TraceabilityLinksModule],
  controllers: [DefectsController],
  providers: [DefectsService, DefectsRepository],
  exports: [DefectsService, DefectsRepository],
})
export class DefectsModule {}
