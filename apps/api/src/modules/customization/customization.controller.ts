import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateCustomFieldInput,
  DefectWorkflowQuery,
  ListCustomFieldsQuery,
  UpdateCustomFieldInput,
  UpdateDefectWorkflowInput,
  createCustomFieldSchema,
  defectWorkflowQuerySchema,
  listCustomFieldsQuerySchema,
  updateCustomFieldSchema,
  updateDefectWorkflowSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CustomFieldsService } from './custom-fields.service';
import { DefectWorkflowService } from './defect-workflow.service';

/**
 * Reading definitions is allowed to anyone who can read one of the entities
 * they describe: the form that edits a defect needs them.
 */
const READ_ANY = ['requirements.read', 'test_design.read', 'defects.read'] as const;

@ApiTags('customization')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @RequirePermission('customization.manage')
  @Post()
  @ApiOperation({ summary: 'Define a custom field for requirements, cases or defects' })
  create(
    @Body(zodBody(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.fields.create(body, user.userId);
  }

  @RequirePermission(...READ_ANY)
  @Get()
  @ApiOperation({ summary: 'List the custom fields of a project' })
  list(@Query(zodQuery(listCustomFieldsQuerySchema)) query: ListCustomFieldsQuery) {
    return this.fields.list(query);
  }

  @RequirePermission(...READ_ANY)
  @Get(':id')
  @ApiOperation({ summary: 'Get a custom field' })
  get(@Param('id') id: string) {
    return this.fields.get(id);
  }

  @RequirePermission('customization.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Relabel, reorder, require or edit the options of a field' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
  ) {
    return this.fields.update(id, body);
  }

  @RequirePermission('customization.manage')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop offering a field; stored values are kept' })
  archive(@Param('id') id: string) {
    return this.fields.setArchived(id, true);
  }

  @RequirePermission('customization.manage')
  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Offer an archived field again' })
  restore(@Param('id') id: string) {
    return this.fields.setArchived(id, false);
  }
}

@ApiTags('customization')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('defect-workflow')
export class DefectWorkflowController {
  constructor(private readonly workflows: DefectWorkflowService) {}

  @RequirePermission('defects.read')
  @Get()
  @ApiOperation({ summary: 'The defect transitions of a project' })
  get(@Query(zodQuery(defectWorkflowQuerySchema)) query: DefectWorkflowQuery) {
    return this.workflows.get(query.projectId);
  }

  @RequirePermission('customization.manage')
  @Put()
  @ApiOperation({ summary: 'Replace the defect workflow of a project' })
  update(@Body(zodBody(updateDefectWorkflowSchema)) body: UpdateDefectWorkflowInput) {
    return this.workflows.update(body);
  }
}
