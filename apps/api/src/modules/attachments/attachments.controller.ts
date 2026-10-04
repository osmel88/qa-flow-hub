import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ALLOWED_FILE_TYPES,
  ListAttachmentsQuery,
  UploadAttachmentQuery,
  listAttachmentsQuerySchema,
  uploadAttachmentQuerySchema,
} from '@qa-flow-hub/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ValidationError } from '../../errors';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AttachmentsService } from './attachments.service';

/**
 * The only door to the bytes. There is no static route over the storage root:
 * every read passes through the tenant guard, the project check and a
 * `Content-Disposition` the server decides, and the browser never learns a
 * storage key or a filesystem path.
 */
@ApiTags('attachments')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('limits')
  @ApiOperation({ summary: 'Accepted file types and size limit' })
  limits() {
    return this.attachments.limits();
  }

  @RequirePermission('attachments.upload')
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({ summary: 'Upload one evidence file to a result, defect, run or case' })
  async upload(
    @Query(zodQuery(uploadAttachmentQuerySchema)) query: UploadAttachmentQuery,
    @Req() request: FastifyRequest,
  ) {
    if (!request.isMultipart()) {
      throw new ValidationError('Expected a multipart/form-data body with one "file" part');
    }
    const part = await request.file();
    if (part === undefined) {
      throw new ValidationError('Expected a multipart/form-data body with one "file" part');
    }
    return this.attachments.upload(query.entityType, query.entityId, {
      fileName: part.filename,
      mimeType: part.mimetype,
      body: part.file,
      truncated: () => part.file.truncated,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List the evidence attached to an entity' })
  list(@Query(zodQuery(listAttachmentsQuerySchema)) query: ListAttachmentsQuery) {
    return this.attachments.list(query.entityType, query.entityId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Attachment metadata' })
  get(@Param('id') id: string) {
    return this.attachments.get(id);
  }

  @Get(':id/content')
  @ApiOperation({ summary: 'Download the bytes (authenticated; never a static path)' })
  async content(
    @Param('id') id: string,
    @Query('disposition') disposition: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { attachment, body } = await this.attachments.content(id);

    // Inline rendering only for the formats browsers display natively and
    // that carry no script: images and PDF. Text is always a download — a
    // `.txt` served inline with a guessed type is how stored XSS starts.
    const kind = ALLOWED_FILE_TYPES.find((type) => type.mimeType === attachment.contentType)?.kind;
    const inline = disposition === 'inline' && (kind === 'image' || kind === 'document');

    reply
      .header('Content-Type', attachment.contentType)
      .header('Content-Length', attachment.sizeBytes)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', contentDisposition(inline, attachment.fileName));
    await reply.send(body);
  }

  @RequirePermission('attachments.delete')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete evidence (uploader, or a project lead)' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.attachments.remove(id);
  }
}

/**
 * RFC 6266: an ASCII fallback in `filename` and the real name, percent
 * encoded, in `filename*`. Quotes and non-ASCII are stripped from the
 * fallback so the header cannot be broken out of by a crafted name.
 */
function contentDisposition(inline: boolean, fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
