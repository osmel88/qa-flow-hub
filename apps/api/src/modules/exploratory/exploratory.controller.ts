import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AddSessionNoteInput,
  ConvertFindingInput,
  CreateExploratorySessionInput,
  CreateFindingInput,
  ExploratoryAction,
  ExploratoryActionInput,
  LinkSessionDefectInput,
  LinkSessionWorkItemInput,
  ListExploratorySessionsQuery,
  UpdateExploratorySessionInput,
  addSessionNoteSchema,
  convertFindingSchema,
  createExploratorySessionSchema,
  createFindingSchema,
  exploratoryActionSchema,
  linkSessionDefectSchema,
  linkSessionWorkItemSchema,
  listExploratorySessionsQuerySchema,
  updateExploratorySessionSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ExploratoryService } from './exploratory.service';

/**
 * Exploratory sessions (S7-F5): reading needs `testruns.read`; creating,
 * running and recording `testruns.execute`; cancelling and archiving
 * `testruns.manage`; turning a finding into a defect `defects.create`.
 */
@ApiTags('exploratory-sessions')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('exploratory-sessions')
export class ExploratoryController {
  constructor(private readonly sessions: ExploratoryService) {}

  @RequirePermission('testruns.read')
  @Get()
  @ApiOperation({ summary: 'Exploratory sessions of a project, with filters' })
  list(@Query(zodQuery(listExploratorySessionsQuerySchema)) query: ListExploratorySessionsQuery) {
    return this.sessions.list(query);
  }

  @RequirePermission('testruns.execute')
  @Post()
  @ApiOperation({ summary: 'Plan an exploratory session with a charter' })
  create(
    @Body(zodBody(createExploratorySessionSchema)) body: CreateExploratorySessionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.create(body, user.userId);
  }

  @RequirePermission('testruns.read')
  @Get(':id')
  @ApiOperation({ summary: 'A session with findings, timeline, links and metrics' })
  get(@Param('id') id: string) {
    return this.sessions.get(id);
  }

  @RequirePermission('testruns.execute')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a planned, active or paused session' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateExploratorySessionSchema)) body: UpdateExploratorySessionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.update(id, body, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/start')
  @HttpCode(200)
  start(
    @Param('id') id: string,
    @Body(zodBody(exploratoryActionSchema)) body: ExploratoryActionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.act(id, 'start', body, user);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/pause')
  @HttpCode(200)
  pause(
    @Param('id') id: string,
    @Body(zodBody(exploratoryActionSchema)) body: ExploratoryActionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.act(id, 'pause', body, user);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/resume')
  @HttpCode(200)
  resume(
    @Param('id') id: string,
    @Body(zodBody(exploratoryActionSchema)) body: ExploratoryActionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.act(id, 'resume', body, user);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @Param('id') id: string,
    @Body(zodBody(exploratoryActionSchema)) body: ExploratoryActionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.act(id, 'complete', body, user);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') id: string,
    @Body(zodBody(exploratoryActionSchema)) body: ExploratoryActionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.act(id, 'cancel', body, user);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/archive')
  @HttpCode(200)
  archive(
    @Param('id') id: string,
    @Body(zodBody(exploratoryActionSchema)) body: ExploratoryActionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.act(id, 'archive', body, user);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/notes')
  @ApiOperation({ summary: 'Add a note to the timeline of a running or paused session' })
  note(
    @Param('id') id: string,
    @Body(zodBody(addSessionNoteSchema)) body: AddSessionNoteInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.addNote(id, body, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/findings')
  @ApiOperation({ summary: 'Record a finding during the session' })
  finding(
    @Param('id') id: string,
    @Body(zodBody(createFindingSchema)) body: CreateFindingInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.addFinding(id, body, user.userId);
  }

  @RequirePermission('defects.create')
  @Post(':id/findings/:findingId/defect')
  @ApiOperation({ summary: 'Turn a finding into a new defect' })
  convert(
    @Param('id') id: string,
    @Param('findingId') findingId: string,
    @Body(zodBody(convertFindingSchema)) body: ConvertFindingInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.convertFinding(id, findingId, body, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/findings/:findingId/link-defect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Relate a finding with an existing defect' })
  linkFinding(
    @Param('id') id: string,
    @Param('findingId') findingId: string,
    @Body(zodBody(linkSessionDefectSchema)) body: LinkSessionDefectInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.linkFindingDefect(id, findingId, body, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/work-items')
  @HttpCode(200)
  linkWorkItem(
    @Param('id') id: string,
    @Body(zodBody(linkSessionWorkItemSchema)) body: LinkSessionWorkItemInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.linkWorkItem(id, body.workItemId, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Delete(':id/work-items/:workItemId')
  unlinkWorkItem(
    @Param('id') id: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.unlinkWorkItem(id, workItemId, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Post(':id/defects')
  @HttpCode(200)
  linkDefect(
    @Param('id') id: string,
    @Body(zodBody(linkSessionDefectSchema)) body: LinkSessionDefectInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.linkDefect(id, body.defectId, user.userId);
  }

  @RequirePermission('testruns.execute')
  @Delete(':id/defects/:defectId')
  unlinkDefect(
    @Param('id') id: string,
    @Param('defectId') defectId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sessions.unlinkDefect(id, defectId, user.userId);
  }

  private act(
    id: string,
    action: ExploratoryAction,
    body: ExploratoryActionInput,
    user: CurrentUserContext,
  ) {
    return this.sessions.transition(id, action, body, user.userId);
  }
}
