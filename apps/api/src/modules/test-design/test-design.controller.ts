import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { attachmentDisposition } from '../exports/csv-writer';
import {
  CreateSectionInput,
  CreateSuiteInput,
  CreateTestCaseInput,
  DuplicateTestCaseInput,
  ImportDatasetInput,
  ReplaceParametersInput,
  importDatasetSchema,
  replaceParametersSchema,
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
  RestoreVersionInput,
  VersionDiffQuery,
  restoreVersionSchema,
  versionDiffQuerySchema,
} from '@qa-flow-hub/shared';
import { NotFoundError } from '../../errors';
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
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(updateTestCaseSchema)) body: UpdateTestCaseInput,
  ) {
    return this.design.updateCase(id, body, user.userId);
  }

  @RequirePermission('test_design.write')
  @Post('test-cases/:id/steps')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the whole ordered list of steps' })
  replaceSteps(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(replaceStepsSchema)) body: ReplaceStepsInput,
  ) {
    return this.design.replaceSteps(id, body, user.userId);
  }

  // --- Versions (S7-F4) ----------------------------------------------------

  @RequirePermission('test_design.read')
  @Get('test-cases/:id/versions')
  @ApiOperation({ summary: 'Version history of a test case, newest first' })
  listVersions(@Param('id') id: string) {
    return this.design.listVersions(id);
  }

  @RequirePermission('test_design.read')
  @Get('test-cases/:id/versions/diff')
  @ApiOperation({ summary: 'Differences between two versions of a test case' })
  diffVersions(
    @Param('id') id: string,
    @Query(zodQuery(versionDiffQuerySchema)) query: VersionDiffQuery,
  ) {
    return this.design.diffVersions(id, query);
  }

  @RequirePermission('test_design.read')
  @Get('test-cases/:id/versions/:version')
  @ApiOperation({ summary: 'The full content of one version' })
  getVersion(@Param('id') id: string, @Param('version') version: string) {
    return this.design.getVersion(id, versionNumber(version));
  }

  @RequirePermission('test_design.write')
  @Post('test-cases/:id/versions/:version/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore an older version as a new version' })
  restoreVersion(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Param('version') version: string,
    @Body(zodBody(restoreVersionSchema)) body: RestoreVersionInput,
  ) {
    return this.design.restoreVersion(id, versionNumber(version), body, user.userId);
  }

  @RequirePermission('test_design.write')
  @Put('test-cases/:id/parameters')
  @ApiOperation({ summary: 'Replace the parameters and dataset of a case, bumping its version' })
  replaceParameters(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(replaceParametersSchema)) body: ReplaceParametersInput,
  ) {
    return this.design.replaceParameters(id, body, user.userId);
  }

  @RequirePermission('test_design.import')
  @Post('test-cases/:id/dataset/import')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the dataset of a case with the rows of a CSV' })
  importDataset(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
    @Body(zodBody(importDatasetSchema)) body: ImportDatasetInput,
  ) {
    return this.design.importDataset(id, body, user.userId);
  }

  @RequirePermission('data.export')
  @Get('test-cases/:id/dataset/export.csv')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'The dataset of a case as CSV' })
  async exportDataset(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.design.exportDataset(id);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', attachmentDisposition(file.fileName))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('X-Export-Rows', String(file.rows));
    await reply.send(file.body);
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

/** A version number in a path; anything else names no version. */
function versionNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new NotFoundError('Test case version');
  }
  return parsed;
}
