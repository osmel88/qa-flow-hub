import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateSectionInput,
  CreateSuiteInput,
  CreateTestCaseInput,
  DuplicateTestCaseInput,
  ListTestCasesQuery,
  ReplaceStepsInput,
  UpdateSectionInput,
  UpdateSuiteInput,
  UpdateTestCaseInput,
  createSectionSchema,
  createSuiteSchema,
  createTestCaseSchema,
  duplicateTestCaseSchema,
  listTestCasesQuerySchema,
  replaceStepsSchema,
  updateSectionSchema,
  updateSuiteSchema,
  updateTestCaseSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { TestDesignService } from './test-design.service';

/** Everyone who designs tests. Testers execute them but do not author them. */
const AUTHORS = ['organization_owner', 'organization_admin', 'project_manager', 'qa_lead'] as const;

@ApiTags('test-design')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller()
export class TestDesignController {
  constructor(private readonly design: TestDesignService) {}

  // --- Suites --------------------------------------------------------------

  @Roles(...AUTHORS)
  @Post('test-suites')
  @ApiOperation({ summary: 'Create a test suite' })
  createSuite(@Body(zodBody(createSuiteSchema)) body: CreateSuiteInput) {
    return this.design.createSuite(body);
  }

  @Get('test-suites')
  @ApiOperation({ summary: 'List a project’s suites with their case counts' })
  listSuites(@Query('projectId') projectId: string) {
    return this.design.listSuites(projectId);
  }

  @Roles(...AUTHORS)
  @Patch('test-suites/:id')
  @ApiOperation({ summary: 'Rename or reposition a suite' })
  updateSuite(@Param('id') id: string, @Body(zodBody(updateSuiteSchema)) body: UpdateSuiteInput) {
    return this.design.updateSuite(id, body);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Delete('test-suites/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a suite together with its sections and cases' })
  async deleteSuite(@Param('id') id: string) {
    await this.design.deleteSuite(id);
  }

  // --- Sections ------------------------------------------------------------

  @Roles(...AUTHORS)
  @Post('test-sections')
  @ApiOperation({ summary: 'Create a section inside a suite' })
  createSection(@Body(zodBody(createSectionSchema)) body: CreateSectionInput) {
    return this.design.createSection(body);
  }

  @Get('test-suites/:id/sections')
  @ApiOperation({ summary: 'The section tree of a suite' })
  sectionTree(@Param('id') id: string) {
    return this.design.sectionTree(id);
  }

  @Roles(...AUTHORS)
  @Patch('test-sections/:id')
  @ApiOperation({ summary: 'Rename, reposition or reparent a section' })
  updateSection(
    @Param('id') id: string,
    @Body(zodBody(updateSectionSchema)) body: UpdateSectionInput,
  ) {
    return this.design.updateSection(id, body);
  }

  @Roles(...AUTHORS)
  @Delete('test-sections/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a section; its cases move to the suite root' })
  async deleteSection(@Param('id') id: string) {
    await this.design.deleteSection(id);
  }

  // --- Cases ---------------------------------------------------------------

  @Roles(...AUTHORS)
  @Post('test-cases')
  @ApiOperation({ summary: 'Create a test case with its steps' })
  createCase(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(createTestCaseSchema)) body: CreateTestCaseInput,
  ) {
    return this.design.createCase(body, user.userId);
  }

  @Get('test-cases')
  @ApiOperation({ summary: 'List test cases with filters' })
  listCases(@Query(zodQuery(listTestCasesQuerySchema)) query: ListTestCasesQuery) {
    return this.design.listCases(query);
  }

  @Get('test-cases/:id')
  @ApiOperation({ summary: 'Test case with its ordered steps' })
  getCase(@Param('id') id: string) {
    return this.design.getCase(id);
  }

  @Roles(...AUTHORS)
  @Patch('test-cases/:id')
  @ApiOperation({ summary: 'Edit a test case, bumping its version' })
  updateCase(
    @Param('id') id: string,
    @Body(zodBody(updateTestCaseSchema)) body: UpdateTestCaseInput,
  ) {
    return this.design.updateCase(id, body);
  }

  @Roles(...AUTHORS)
  @Post('test-cases/:id/steps')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the whole ordered list of steps' })
  replaceSteps(
    @Param('id') id: string,
    @Body(zodBody(replaceStepsSchema)) body: ReplaceStepsInput,
  ) {
    return this.design.replaceSteps(id, body);
  }

  @Roles(...AUTHORS)
  @Post('test-cases/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate a case and its steps under a new key' })
  duplicateCase(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(duplicateTestCaseSchema)) body: DuplicateTestCaseInput,
  ) {
    return this.design.duplicateCase(id, body, user.userId);
  }

  @Roles(...AUTHORS)
  @Post('test-cases/:id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a case so it stops being planned' })
  archiveCase(@Param('id') id: string) {
    return this.design.archiveCase(id);
  }

  @Roles(...AUTHORS)
  @Post('test-cases/:id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring an archived case back' })
  restoreCase(@Param('id') id: string) {
    return this.design.restoreCase(id);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Delete('test-cases/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a test case' })
  async deleteCase(@Param('id') id: string) {
    await this.design.deleteCase(id);
  }
}
