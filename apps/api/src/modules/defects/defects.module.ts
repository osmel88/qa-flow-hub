import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsModule } from '../projects/projects.module';
import { DefectsController } from './defects.controller';
import { DefectsRepository } from './defects.repository';
import { DefectsService } from './defects.service';

@Module({
  imports: [ProjectsModule, OrganizationsModule],
  controllers: [DefectsController],
  providers: [DefectsService, DefectsRepository],
  exports: [DefectsService, DefectsRepository],
})
export class DefectsModule {}
