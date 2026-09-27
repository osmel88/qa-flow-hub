import { z } from 'zod';

/**
 * Entities that can carry evidence. A subset of `LinkableEntity` on purpose:
 * a requirement or a suite is a specification, and evidence belongs to what
 * happened (a result, a defect) or to what is about to happen (a run, a case
 * with a reference screenshot).
 */
export const ATTACHABLE_ENTITIES = ['test_result', 'defect', 'test_run', 'test_case'] as const;
export type AttachableEntity = (typeof ATTACHABLE_ENTITIES)[number];
export const attachableEntitySchema = z.enum(ATTACHABLE_ENTITIES);

/**
 * The allow-list. Both sides of the pair are checked against what the client
 * declared *and* against the bytes themselves where the format has a magic
 * number; `text/*` and JSON are checked to be text. A type absent from this
 * table is refused with `UNSUPPORTED_FILE_TYPE`, never stored "just in case".
 *
 * Shared with the web client so the file picker can restrict the dialog and
 * explain the rule before a round trip.
 */
export const ALLOWED_FILE_TYPES: ReadonlyArray<{
  mimeType: string;
  extensions: readonly string[];
  kind: 'image' | 'text' | 'document';
}> = [
  { mimeType: 'image/png', extensions: ['png'], kind: 'image' },
  { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg'], kind: 'image' },
  { mimeType: 'image/gif', extensions: ['gif'], kind: 'image' },
  { mimeType: 'image/webp', extensions: ['webp'], kind: 'image' },
  { mimeType: 'text/plain', extensions: ['txt', 'log'], kind: 'text' },
  { mimeType: 'application/json', extensions: ['json'], kind: 'text' },
  { mimeType: 'application/pdf', extensions: ['pdf'], kind: 'document' },
];

export const ALLOWED_MIME_TYPES = ALLOWED_FILE_TYPES.map((type) => type.mimeType);
export const ALLOWED_EXTENSIONS = ALLOWED_FILE_TYPES.flatMap((type) => type.extensions);

export const listAttachmentsQuerySchema = z.object({
  entityType: attachableEntitySchema,
  entityId: z.string().min(1),
});
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuerySchema>;

/** The target travels in the query string: the body is the multipart file. */
export const uploadAttachmentQuerySchema = listAttachmentsQuerySchema;
export type UploadAttachmentQuery = z.infer<typeof uploadAttachmentQuerySchema>;

export interface AttachmentView {
  id: string;
  projectId: string;
  entityType: AttachableEntity;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  uploadedById: string | null;
  uploadedByName: string | null;
  createdAt: string;
  /** `/attachments/:id/content`, relative to the API base. Never a storage path. */
  contentPath: string;
}

/** What the API accepts, so the client can refuse locally before uploading. */
export interface AttachmentLimitsView {
  maxSizeBytes: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  storageProvider: string;
}
