import { Module } from '@nestjs/common';
import { CustomizationModule } from '../customization/customization.module';
import { ProjectsModule } from '../projects/projects.module';
import { ExploratoryController } from './exploratory.controller';
import { ExploratoryRepository } from './exploratory.repository';
import { ExploratoryService } from './exploratory.service';

@Module({
  imports: [ProjectsModule, CustomizationModule],
  controllers: [ExploratoryController],
  providers: [ExploratoryService, ExploratoryRepository],
})
export class ExploratoryModule {}
