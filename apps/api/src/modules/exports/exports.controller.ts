import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  ExportMatrixQuery,
  ExportTestCasesQuery,
  exportMatrixQuerySchema,
  exportTestCasesQuerySchema,
} from '@qa-flow-hub/shared';
import type { FastifyReply } from 'fastify';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { attachmentDisposition } from './csv-writer';
import { CsvExport, ExportsService } from './exports.service';

@ApiTags('exports')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @RequirePermission('test_design.read', 'data.export')
  @Get('projects/:projectId/exports/test-cases.csv')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Test cases as CSV (the import template: it imports back)' })
  async testCases(
    @Param('projectId') projectId: string,
    @Query(zodQuery(exportTestCasesQuerySchema)) query: ExportTestCasesQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.exports.testCases(projectId, query));
  }

  @RequirePermission('testruns.read', 'data.export')
  @Get('test-runs/:id/export.csv')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'A run as CSV, from its snapshots' })
  async testRun(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    await send(reply, await this.exports.testRun(id));
  }

  @RequirePermission('traceability.read', 'data.export')
  @Get('traceability/matrix/export.csv')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'The traceability matrix as CSV' })
  async matrix(
    @Query(zodQuery(exportMatrixQuerySchema)) query: ExportMatrixQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.exports.matrix(query));
  }
}

async function send(reply: FastifyReply, file: CsvExport): Promise<void> {
  reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', attachmentDisposition(file.fileName))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .header('X-Export-Rows', String(file.rows));
  await reply.send(file.body);
}
