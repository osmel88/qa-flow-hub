import { createHash } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';
import { ALLOWED_FILE_TYPES } from '@qa-flow-hub/shared';

export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

/**
 * The user's file name is display data and nothing else, but it still gets
 * bounded and stripped of anything that would make a `Content-Disposition`
 * header or a UI list misbehave: path separators, control characters, and
 * length. `..` survives — it is harmless in a name that is never a path.
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- the point is to remove them
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  const bounded = cleaned.length > 255 ? cleaned.slice(cleaned.length - 255) : cleaned;
  return bounded === '' ? 'file' : bounded;
}

export function extensionOf(fileName: string): string | null {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) {
    return null;
  }
  return fileName.slice(index + 1).toLowerCase();
}

/**
 * Declared type and extension must agree *and* both be on the list. A
 * `report.exe` sent as `text/plain` fails on the extension; a `notes.txt`
 * sent as `application/octet-stream` fails on the type. Parameters after `;`
 * (charset) are ignored, and browsers that send `text/x-log` for `.log`
 * are treated as `text/plain` because the extension is what the list keys on.
 */
export function resolveAllowedType(fileName: string, declaredMime: string): AllowedFileType | null {
  const extension = extensionOf(fileName);
  if (extension === null) {
    return null;
  }
  const byExtension = ALLOWED_FILE_TYPES.find((type) => type.extensions.includes(extension));
  if (byExtension === undefined) {
    return null;
  }
  const mime = declaredMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === byExtension.mimeType) {
    return byExtension;
  }
  if (byExtension.kind === 'text' && (mime.startsWith('text/') || mime === '')) {
    return byExtension;
  }
  return null;
}

const MAGIC: ReadonlyArray<{ mimeType: string; bytes: number[]; offset?: number }> = [
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mimeType: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { mimeType: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/**
 * Formats with a signature must start with it. Text formats have none; for
 * them "no NUL byte in the first 8 KiB" is the check that separates a log
 * from a renamed binary, which is what the allow-list is defending against.
 */
export function contentMatches(type: AllowedFileType, inspection: StreamInspection): boolean {
  if (inspection.sizeBytes === 0) {
    return false;
  }
  if (type.kind === 'text') {
    return !inspection.sawNul;
  }
  const signatures = MAGIC.filter((magic) => magic.mimeType === type.mimeType);
  return signatures.every((magic) => {
    const offset = magic.offset ?? 0;
    return magic.bytes.every((byte, index) => inspection.head[offset + index] === byte);
  });
}

export interface StreamInspection {
  sizeBytes: number;
  sha256: string;
  head: Buffer;
  sawNul: boolean;
}

const HEAD_BYTES = 16;
const NUL_SCAN_BYTES = 8 * 1024;

/**
 * A pass-through that measures what flows to the provider: size, hash, the
 * first bytes for signature checks and whether a NUL appeared early. One pass
 * over the bytes, no buffering of the body.
 */
export class InspectingStream extends Transform {
  private readonly hash = createHash('sha256');
  private readonly headChunks: Buffer[] = [];
  private headLength = 0;
  private sawNul = false;
  private scanned = 0;
  sizeBytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.sizeBytes += chunk.length;
    this.hash.update(chunk);
    if (this.headLength < HEAD_BYTES) {
      this.headChunks.push(chunk.subarray(0, HEAD_BYTES - this.headLength));
      this.headLength = Math.min(HEAD_BYTES, this.headLength + chunk.length);
    }
    if (!this.sawNul && this.scanned < NUL_SCAN_BYTES) {
      const window = chunk.subarray(0, NUL_SCAN_BYTES - this.scanned);
      this.sawNul = window.includes(0);
      this.scanned += window.length;
    }
    callback(null, chunk);
  }

  result(): StreamInspection {
    return {
      sizeBytes: this.sizeBytes,
      sha256: this.hash.digest('hex'),
      head: Buffer.concat(this.headChunks),
      sawNul: this.sawNul,
    };
  }
}
