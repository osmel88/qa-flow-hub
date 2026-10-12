import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreateImportQuery, createImportQuerySchema } from '@qa-flow-hub/shared';
import type { FastifyRequest } from 'fastify';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { AppConfigService } from '../../config/app-config.service';
import { ImportTooLargeError, ValidationError } from '../../errors';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ImportsService } from './imports.service';

@ApiTags('imports')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('projects/:projectId/imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly config: AppConfigService,
  ) {}

  @RequirePermission('test_design.import')
  @Get('limits')
  @ApiOperation({ summary: 'Size, row, case and step limits of an import' })
  async limits(@Param('projectId') projectId: string) {
    await this.imports.assertAccess(projectId);
    return this.imports.limits();
  }

  @RequirePermission('test_design.import')
  @Get()
  @ApiOperation({ summary: 'Import history of the project (latest 50)' })
  list(@Param('projectId') projectId: string) {
    return this.imports.list(projectId);
  }

  @RequirePermission('test_design.import')
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({ summary: 'Dry run: validate and plan a CSV import without writing any case' })
  async dryRun(
    @Param('projectId') projectId: string,
    @Query(zodQuery(createImportQuerySchema)) query: CreateImportQuery,
    @Req() request: FastifyRequest,
    @CurrentUser() user: CurrentUserContext,
  ) {
    if (!request.isMultipart()) {
      throw new ValidationError('Expected a multipart/form-data body with one "file" part');
    }
    const maxBytes = this.config.imports.maxBytes;
    const part = await request.file({ limits: { fileSize: maxBytes, files: 1 } });
    if (part === undefined) {
      throw new ValidationError('Expected a multipart/form-data body with one "file" part');
    }
    const buffer = await part.toBuffer();
    if (part.file.truncated || buffer.length > maxBytes) {
      throw new ImportTooLargeError('bytes', maxBytes);
    }
    return this.imports.dryRun(projectId, query, { fileName: part.filename, buffer }, user.userId);
  }

  @RequirePermission('test_design.import')
  @Get(':id')
  @ApiOperation({ summary: 'An import job with its row-by-row report' })
  get(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.imports.get(projectId, id);
  }

  @RequirePermission('test_design.import')
  @Post(':id/commit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply the stored plan of a ready dry run, atomically' })
  commit(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.imports.commit(projectId, id, user.userId);
  }
}
