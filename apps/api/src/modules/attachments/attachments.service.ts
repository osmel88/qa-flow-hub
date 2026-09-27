import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  AttachableEntity,
  AttachmentLimitsView,
  AttachmentView,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  attachableEntitySchema,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContextService } from '../../database/tenant-context.service';
import {
  FileTooLargeError,
  ForbiddenError,
  NotFoundError,
  UnsupportedFileTypeError,
  ValidationError,
} from '../../errors';
import { STORAGE_PROVIDER, StorageProvider } from '../../storage/storage-provider';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { AttachmentRow, AttachmentsRepository } from './attachments.repository';
import {
  InspectingStream,
  contentMatches,
  extensionOf,
  resolveAllowedType,
  sanitizeFileName,
} from './file-inspection';

/** What the transport hands over: a name, a declared type and the bytes. */
export interface UploadSource {
  fileName: string;
  mimeType: string;
  body: Readable;
  /**
   * Whether the transport cut the body at its own limit. Multipart parsers
   * truncate rather than fail, so the service asks after the stream ended.
   */
  truncated: () => boolean;
}

export interface AttachmentContent {
  attachment: AttachmentView;
  body: Readable;
}

/**
 * Roles that may remove evidence somebody else uploaded. Testers can delete
 * their own — a wrong screenshot is a normal mistake — but not a colleague's:
 * evidence is the record the rest of the team argues from.
 */
const CURATORS = ['organization_owner', 'organization_admin', 'project_manager', 'qa_lead'];

/**
 * Evidence, end to end: authorization, allow-list, streaming to the provider
 * with inspection on the way, metadata, audit. It depends on the
 * `StorageProvider` token and knows nothing about disks or buckets.
 *
 * Order of operations on upload matters and is deliberate:
 *   1. resolve the entity → project → permission, before a byte is read;
 *   2. refuse the declared type/extension, still before reading;
 *   3. stream to the provider while hashing and sniffing;
 *   4. if the bytes disagree with the declaration or exceeded the limit,
 *      delete the object and refuse;
 *   5. only then write the row and the audit entry.
 * A crash between 3 and 5 leaves an orphan object and no row — the cheap
 * failure. The reverse (a row with no object) would be a 404 on download
 * that nobody could explain, so the row is always written last.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly attachments: AttachmentsRepository,
    private readonly access: ProjectAccessService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  limits(): AttachmentLimitsView {
    return {
      maxSizeBytes: this.config.storage.maxSizeBytes,
      allowedMimeTypes: [...ALLOWED_MIME_TYPES],
      allowedExtensions: [...ALLOWED_EXTENSIONS],
      storageProvider: this.storage.name,
    };
  }

  async upload(
    entityType: AttachableEntity,
    entityId: string,
    source: UploadSource,
  ): Promise<AttachmentView> {
    const projectId = await this.resolveTarget(entityType, entityId);
    const userId = this.tenant.requireUserId();

    const fileName = sanitizeFileName(source.fileName);
    const type = resolveAllowedType(fileName, source.mimeType);
    if (type === null) {
      source.body.resume();
      throw new UnsupportedFileTypeError(
        `"${fileName}" is not an accepted evidence type (${ALLOWED_EXTENSIONS.join(', ')})`,
      );
    }

    const extension = extensionOf(fileName) ?? type.extensions[0] ?? 'bin';
    const key = this.buildKey(projectId, entityType, extension);
    const inspector = new InspectingStream();
    // `pipe` does not forward errors; without this a broken upload would leave
    // the provider waiting on a stream that never ends.
    source.body.on('error', (error: Error) => inspector.destroy(error));
    source.body.pipe(inspector);

    await this.storage.put(key, inspector, { contentType: type.mimeType });
    const inspection = inspector.result();

    const maxSizeBytes = this.config.storage.maxSizeBytes;
    if (source.truncated() || inspection.sizeBytes > maxSizeBytes) {
      await this.discard(key);
      throw new FileTooLargeError(maxSizeBytes);
    }
    if (!contentMatches(type, inspection)) {
      await this.discard(key);
      throw new UnsupportedFileTypeError(
        `"${fileName}" does not look like ${type.mimeType}; the content was refused`,
      );
    }

    const row = await this.attachments.create({
      projectId,
      entityType,
      entityId,
      fileName,
      contentType: type.mimeType,
      sizeBytes: inspection.sizeBytes,
      checksum: inspection.sha256,
      storageProvider: this.storage.name,
      storageKey: key,
      uploadedById: userId,
    });

    await this.audit.record({
      action: AuditAction.create,
      entityType: 'Attachment',
      entityId: row.id,
      summary: `Uploaded ${fileName} (${type.mimeType}, ${inspection.sizeBytes} bytes) to ${entityType} ${entityId}`,
      changes: {
        entityType,
        entityId,
        fileName,
        contentType: type.mimeType,
        sizeBytes: inspection.sizeBytes,
        checksum: inspection.sha256,
      },
    });

    return toView(row);
  }

  async list(
    entityType: AttachableEntity,
    entityId: string,
  ): Promise<{ data: AttachmentView[] }> {
    await this.resolveTarget(entityType, entityId);
    const rows = await this.attachments.listFor(entityType, entityId);
    return { data: rows.map(toView) };
  }

  async get(id: string): Promise<AttachmentView> {
    const row = await this.requireRow(id);
    await this.access.assertRouteAccess(row.projectId);
    return toView(row);
  }

  /**
   * Authorizes on the row's project, then opens the object. A row whose object
   * is gone is a 404 too — and a logged one, because it means the two stores
   * disagree, which no user action can cause.
   */
  async content(id: string): Promise<AttachmentContent> {
    const row = await this.requireRow(id);
    await this.access.assertRouteAccess(row.projectId);

    const body = await this.storage.get(row.storageKey);
    if (body === null) {
      this.logger.warn(`Attachment ${row.id} has no object behind its storage key`);
      throw new NotFoundError('Attachment content');
    }
    return { attachment: toView(row), body };
  }

  /**
   * Physical first, logical second. If the provider fails nothing has changed
   * and the 503 is honest: the evidence is still there, try again. If the
   * object goes and the row update then fails, the row points at nothing,
   * which `content()` already reports as a 404 and a retry of this call
   * repairs (`delete` is idempotent). The opposite order would answer an
   * error for a deletion that had in fact happened.
   */
  async remove(id: string): Promise<void> {
    const row = await this.requireRow(id);
    const role = await this.access.assertRouteAccess(row.projectId);
    const userId = this.tenant.requireUserId();

    if (!CURATORS.includes(role) && row.uploadedById !== userId) {
      throw new ForbiddenError('Only the uploader or a project lead can delete this evidence');
    }

    await this.storage.delete(row.storageKey);

    const deleted = await this.attachments.softDelete(id);
    if (!deleted) {
      throw new NotFoundError('Attachment');
    }

    await this.audit.record({
      action: AuditAction.delete,
      entityType: 'Attachment',
      entityId: row.id,
      summary: `Deleted ${row.fileName} from ${row.entityType} ${row.entityId}`,
      changes: {
        entityType: row.entityType,
        entityId: row.entityId,
        fileName: row.fileName,
        checksum: row.checksum,
      },
    });
  }

  private async resolveTarget(entityType: AttachableEntity, entityId: string): Promise<string> {
    if (!attachableEntitySchema.safeParse(entityType).success) {
      throw new ValidationError('Unsupported entity type for attachments');
    }
    const projectId = await this.attachments.resolveProject(entityType, entityId);
    if (projectId === null) {
      throw new NotFoundError(humanize(entityType));
    }
    await this.access.assertRouteAccess(projectId);
    return projectId;
  }

  private async requireRow(id: string): Promise<AttachmentRow> {
    const row = await this.attachments.findActiveById(id);
    if (row === null) {
      throw new NotFoundError('Attachment');
    }
    return row;
  }

  /**
   * `org/<orgId>/project/<projectId>/<entityType>/<uuid>.<ext>` — every
   * segment is server-generated. Tenant and project are in the key so a
   * provider can be partitioned (or a bucket prefix listed) per customer, and
   * so a key alone tells an operator whose evidence it is.
   */
  private buildKey(projectId: string, entityType: AttachableEntity, extension: string): string {
    const organizationId = this.tenant.requireOrganizationId();
    return `org/${organizationId}/project/${projectId}/${entityType}/${randomUUID()}.${extension}`;
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not remove refused upload ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function toView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    projectId: row.projectId,
    entityType: attachableEntitySchema.parse(row.entityType),
    entityId: row.entityId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    uploadedById: row.uploadedById,
    uploadedByName: row.uploadedBy?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    contentPath: `/attachments/${row.id}/content`,
  };
}

function humanize(entityType: AttachableEntity): string {
  return entityType.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}
