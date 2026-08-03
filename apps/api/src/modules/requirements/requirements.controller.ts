import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChangeRequirementStatusInput,
  CreateRequirementInput,
  ListRequirementsQuery,
  UpdateRequirementInput,
  changeRequirementStatusSchema,
  createRequirementSchema,
  listRequirementsQuerySchema,
  updateRequirementSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirementsService } from './requirements.service';

@ApiTags('requirements')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('requirements')
export class RequirementsController {
  constructor(private readonly requirements: RequirementsService) {}

  @Roles('organization_owner', 'organization_admin', 'project_manager', 'qa_lead')
  @Post()
  @ApiOperation({ summary: 'Create a requirement and reserve its key' })
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(createRequirementSchema)) body: CreateRequirementInput,
  ) {
    return this.requirements.create(body, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'List a project’s requirements with filters' })
  list(@Query(zodQuery(listRequirementsQuerySchema)) query: ListRequirementsQuery) {
    return this.requirements.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Requirement detail' })
  get(@Param('id') id: string) {
    return this.requirements.get(id);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Every version of a requirement, newest first' })
  history(@Param('id') id: string) {
    return this.requirements.history(id);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager', 'qa_lead')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a requirement, appending a version' })
  update(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(updateRequirementSchema)) body: UpdateRequirementInput,
  ) {
    return this.requirements.update(id, body, user.userId);
  }

  /**
   * Status lives behind its own endpoint because moving to `approved` is an
   * approval: it follows a transition table and it is what somebody will look
   * for in the audit log six months from now.
   */
  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Post(':id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a requirement through its workflow' })
  changeStatus(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(changeRequirementStatusSchema)) body: ChangeRequirementStatusInput,
  ) {
    return this.requirements.changeStatus(id, body, user.userId);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager', 'qa_lead')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a requirement' })
  async remove(@Param('id') id: string) {
    await this.requirements.remove(id);
  }
}
