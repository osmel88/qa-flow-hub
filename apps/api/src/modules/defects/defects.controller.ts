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
  ChangeDefectStatusInput,
  CreateDefectInput,
  ListDefectsQuery,
  UpdateDefectInput,
  changeDefectStatusSchema,
  createDefectSchema,
  listDefectsQuerySchema,
  updateDefectSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { DefectsService } from './defects.service';

/** Reporting a defect is the tester's core output, so testers can create. */
const REPORTERS = [
  'organization_owner',
  'organization_admin',
  'project_manager',
  'qa_lead',
  'tester',
] as const;

@ApiTags('defects')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('defects')
export class DefectsController {
  constructor(private readonly defects: DefectsService) {}

  @Roles(...REPORTERS)
  @Post()
  @ApiOperation({ summary: 'Report a defect, optionally from a failed result' })
  create(
    @Body(zodBody(createDefectSchema)) body: CreateDefectInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.defects.create(body, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'List defects with filters' })
  list(@Query(zodQuery(listDefectsQuerySchema)) query: ListDefectsQuery) {
    return this.defects.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a defect' })
  get(@Param('id') id: string) {
    return this.defects.get(id);
  }

  @Roles(...REPORTERS)
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a defect' })
  update(@Param('id') id: string, @Body(zodBody(updateDefectSchema)) body: UpdateDefectInput) {
    return this.defects.update(id, body);
  }

  @Roles(...REPORTERS)
  @Post(':id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a defect through its workflow' })
  changeStatus(
    @Param('id') id: string,
    @Body(zodBody(changeDefectStatusSchema)) body: ChangeDefectStatusInput,
  ) {
    return this.defects.changeStatus(id, body);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft delete a defect' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.defects.remove(id);
  }
}
