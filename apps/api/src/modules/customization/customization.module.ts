import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { CustomFieldValuesService } from './custom-field-values.service';
import { CustomFieldsController, DefectWorkflowController } from './customization.controller';
import { CustomFieldsRepository } from './custom-fields.repository';
import { CustomFieldsService } from './custom-fields.service';
import { DefectWorkflowService } from './defect-workflow.service';

/** Custom fields and the configurable defect workflow (S3-F7). */
@Module({
  imports: [ProjectsModule],
  controllers: [CustomFieldsController, DefectWorkflowController],
  providers: [
    CustomFieldsRepository,
    CustomFieldsService,
    CustomFieldValuesService,
    DefectWorkflowService,
  ],
  exports: [CustomFieldValuesService, DefectWorkflowService],
})
export class CustomizationModule {}
