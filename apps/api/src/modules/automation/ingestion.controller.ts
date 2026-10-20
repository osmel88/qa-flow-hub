import { Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiBodyOptions,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyScope as DbApiKeyScope } from '@prisma/client';
import {
  INGESTION_IDEMPOTENCY_HEADER,
  IngestReportQuery,
  IngestionFormat,
  IngestionResultView,
  ingestReportQuerySchema,
} from '@qa-flow-hub/shared';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ReportTooLargeError, ValidationError } from '../../errors';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SkipOrganization } from '../auth/decorators/skip-organization.decorator';
import { ProjectAccessService } from '../projects/project-access.service';
import { tokenFromHeaders } from './api-key-token';
import { IngestionService } from './ingestion.service';

export const INGEST_ROUTE = 'ingest';

const FILE_BODY: ApiBodyOptions = {
  schema: {
    type: 'object',
    properties: { file: { type: 'string', format: 'binary' } },
    required: ['file'],
  },
};

/**
 * Machine endpoints for CI. No JWT and no X-Organization-Id: the API key in
 * `Authorization: Bearer qfh_…` (or `X-Api-Key`) decides organization and
 * project, and nothing in the request can point it elsewhere.
 */
@ApiTags('automation')
@Public()
@SkipOrganization()
@Controller(INGEST_ROUTE)
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly tenant: TenantContextService,
    private readonly config: AppConfigService,
  ) {}

  @Post('junit')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiHeader({ name: 'Authorization', description: 'Bearer qfh_… API key', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Ingest a JUnit XML report into a test run' })
  junit(
    @Req() request: FastifyRequest,
    @Query(zodQuery(ingestReportQuerySchema)) query: IngestReportQuery,
    @Headers(INGESTION_IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
  ): Promise<IngestionResultView> {
    return this.handle('junit_xml', request, query, idempotencyKey);
  }

  @Post('playwright')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiHeader({ name: 'Authorization', description: 'Bearer qfh_… API key', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Ingest a Playwright JSON report into a test run' })
  playwright(
    @Req() request: FastifyRequest,
    @Query(zodQuery(ingestReportQuerySchema)) query: IngestReportQuery,
    @Headers(INGESTION_IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
  ): Promise<IngestionResultView> {
    return this.handle('playwright_json', request, query, idempotencyKey);
  }

  private async handle(
    format: IngestionFormat,
    request: FastifyRequest,
    query: IngestReportQuery,
    idempotencyKey: string | undefined,
  ): Promise<IngestionResultView> {
    const token = tokenFromHeaders(request.headers);
    const organizationId = await this.ingestion.organizationOf(token);
    return this.tenant.runForOrganization(organizationId, async () => {
      // The key is verified before the body is read: an anonymous client
      // cannot make the API buffer megabytes.
      const key = await this.ingestion.verify(token ?? '', DbApiKeyScope.results_ingest);
      const file = await this.readFile(request);
      return this.ingestion.ingest(key, {
        format,
        fileName: file.fileName,
        buffer: file.buffer,
        idempotencyKey,
        query,
      });
    });
  }

  private async readFile(request: FastifyRequest): Promise<{ fileName: string; buffer: Buffer }> {
    if (!request.isMultipart()) {
      throw new ValidationError('Expected a multipart/form-data body with one "file" part');
    }
    const maxBytes = this.config.ingestion.maxBytes;
    let part;
    let buffer: Buffer;
    try {
      part = await request.file({ limits: { fileSize: maxBytes, files: 1 } });
      if (part === undefined) {
        throw new ValidationError('Expected a multipart/form-data body with one "file" part');
      }
      buffer = await part.toBuffer();
    } catch (error) {
      if (isFileTooLarge(error)) {
        throw new ReportTooLargeError('bytes', maxBytes);
      }
      throw error;
    }
    if (part.file.truncated || buffer.length > maxBytes) {
      throw new ReportTooLargeError('bytes', maxBytes);
    }
    return { fileName: part.filename.slice(0, 255) || 'report', buffer };
  }
}

function isFileTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

/** History of ingested reports, for the people who manage the project's keys. */
@ApiTags('automation')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('projects/:projectId/ingestion-reports')
export class IngestionReportsController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly access: ProjectAccessService,
  ) {}

  @RequirePermission('api_keys.manage')
  @Get()
  @ApiOperation({ summary: 'Latest ingested reports of the project' })
  async list(@Param('projectId') projectId: string) {
    await this.access.assertRouteAccess(projectId);
    return this.ingestion.listReports(projectId);
  }
}
