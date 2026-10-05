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
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { TestDesignService } from './test-design.service';

@ApiTags('test-design')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller()
export class TestDesignController {
  constructor(private readonly design: TestDesignService) {}

  // --- Suites --------------------------------------------------------------

  @RequirePermission('test_design.write')
  @Post('test-suites')
  @ApiOperation({ summary: 'Create a test suite' })
  createSuite(@Body(zodBody(createSuiteSchema)) body: CreateSuiteInput) {
    return this.design.createSuite(body);
  }

  @RequirePermission('test_design.read')
  @Get('test-suites')
  @ApiOperation({ summary: 'List a project’s suites with their case counts' })
  listSuites(@Query('projectId') projectId: string | undefined) {
    return this.design.listSuites(projectId);
  }

  @RequirePermission('test_design.write')
  @Patch('test-suites/:id')
  @ApiOperation({ summary: 'Rename or reposition a suite' })
  updateSuite(@Param('id') id: string, @Body(zodBody(updateSuiteSchema)) body: UpdateSuiteInput) {
    return this.design.updateSuite(id, body);
  }

  @RequirePermission('test_design.manage')
  @Delete('test-suites/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a suite together with its sections and cases' })
  async deleteSuite(@Param('id') id: string) {
    await this.design.deleteSuite(id);
  }

  // --- Sections ------------------------------------------------------------

  @RequirePermission('test_design.write')
  @Post('test-sections')
  @ApiOperation({ summary: 'Create a section inside a suite' })
  createSection(@Body(zodBody(createSectionSchema)) body: CreateSectionInput) {
    return this.design.createSection(body);
  }

  @RequirePermission('test_design.read')
  @Get('test-suites/:id/sections')
  @ApiOperation({ summary: 'The section tree of a suite' })
  sectionTree(@Param('id') id: string) {
    return this.design.sectionTree(id);
  }

  @RequirePermission('test_design.write')
  @Patch('test-sections/:id')
  @ApiOperation({ summary: 'Rename, reposition or reparent a section' })
  updateSection(
    @Param('id') id: string,
    @Body(zodBody(updateSectionSchema)) body: UpdateSectionInput,
  ) {
    return this.design.updateSection(id, body);
  }

  @RequirePermission('test_design.write')
  @Delete('test-sections/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a section; its cases move to the suite root' })
  async deleteSection(@Param('id') id: string) {
    await this.design.deleteSection(id);
  }

  // --- Cases ---------------------------------------------------------------

  @RequirePermission('test_design.write')
  @Post('test-cases')
  @ApiOperation({ summary: 'Create a test case with its steps' })
  createCase(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(createTestCaseSchema)) body: CreateTestCaseInput,
  ) {
    return this.design.createCase(body, user.userId);
  }

  @RequirePermission('test_design.read')
  @Get('test-cases')
  @ApiOperation({ summary: 'List test cases with filters' })
  listCases(@Query(zodQuery(listTestCasesQuerySchema)) query: ListTestCasesQuery) {
    return this.design.listCases(query);
  }

  @RequirePermission('test_design.read')
  @Get('test-cases/:id')
  @ApiOperation({ summary: 'Test case with its ordered steps' })
  getCase(@Param('id') id: string) {
    return this.design.getCase(id);
  }

  @RequirePermission('test_design.write')
  @Patch('test-cases/:id')
  @ApiOperation({ summary: 'Edit a test case, bumping its version' })
  updateCase(
    @Param('id') id: string,
    @Body(zodBody(updateTestCaseSchema)) body: UpdateTestCaseInput,
  ) {
    return this.design.updateCase(id, body);
  }

  @RequirePermission('test_design.write')
  @Post('test-cases/:id/steps')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the whole ordered list of steps' })
  replaceSteps(
    @Param('id') id: string,
    @Body(zodBody(replaceStepsSchema)) body: ReplaceStepsInput,
  ) {
    return this.design.replaceSteps(id, body);
  }

  @RequirePermission('test_design.write')
  @Post('test-cases/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate a case and its steps under a new key' })
  duplicateCase(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(duplicateTestCaseSchema)) body: DuplicateTestCaseInput,
  ) {
    return this.design.duplicateCase(id, body, user.userId);
  }

  @RequirePermission('test_design.write')
  @Post('test-cases/:id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a case so it stops being planned' })
  archiveCase(@Param('id') id: string) {
    return this.design.archiveCase(id);
  }

  @RequirePermission('test_design.write')
  @Post('test-cases/:id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring an archived case back' })
  restoreCase(@Param('id') id: string) {
    return this.design.restoreCase(id);
  }

  @RequirePermission('test_design.manage')
  @Delete('test-cases/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a test case' })
  async deleteCase(@Param('id') id: string) {
    await this.design.deleteCase(id);
  }
}
