import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ALLOWED_FILE_TYPES } from '@qa-flow-hub/shared';
import { describe, expect, it } from 'vitest';
import {
  AllowedFileType,
  InspectingStream,
  StreamInspection,
  contentMatches,
  extensionOf,
  resolveAllowedType,
  sanitizeFileName,
} from './file-inspection';

const type = (mimeType: string): AllowedFileType => {
  const found = ALLOWED_FILE_TYPES.find((entry) => entry.mimeType === mimeType);
  if (found === undefined) {
    throw new Error(`${mimeType} is not on the allow-list`);
  }
  return found;
};

async function inspect(...chunks: Buffer[]): Promise<StreamInspection> {
  const stream = new InspectingStream();
  await pipeline(Readable.from(chunks), stream, async (source) => {
    for await (const _chunk of source) {
      // drain
    }
  });
  return stream.result();
}

describe('sanitizeFileName', () => {
  it('keeps only the last path segment and strips control characters and quotes', () => {
    expect(sanitizeFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFileName('C:\\Users\\qa\\shot.png')).toBe('shot.png');
    expect(sanitizeFileName('log\u0000\u001f"file".log')).toBe('logfile.log');
    expect(sanitizeFileName('  spaced.json  ')).toBe('spaced.json');
  });

  it('never returns an empty name and bounds the length keeping the extension', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('/')).toBe('file');
    const long = `${'a'.repeat(300)}.txt`;
    expect(sanitizeFileName(long)).toHaveLength(255);
    expect(sanitizeFileName(long).endsWith('.txt')).toBe(true);
  });
});

describe('extensionOf', () => {
  it('lower-cases and ignores dot files and trailing dots', () => {
    expect(extensionOf('Shot.PNG')).toBe('png');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('.env')).toBeNull();
    expect(extensionOf('noext')).toBeNull();
    expect(extensionOf('trailing.')).toBeNull();
  });
});

describe('resolveAllowedType', () => {
  it('accepts an allow-listed extension whose declared type agrees', () => {
    expect(resolveAllowedType('shot.png', 'image/png')?.mimeType).toBe('image/png');
    expect(resolveAllowedType('photo.JPEG', 'image/jpeg')?.mimeType).toBe('image/jpeg');
    expect(resolveAllowedType('report.pdf', 'application/pdf')?.kind).toBe('document');
    expect(resolveAllowedType('data.json', 'application/json; charset=utf-8')?.kind).toBe('text');
  });

  it('is lenient about the declared type of text only', () => {
    expect(resolveAllowedType('app.log', 'text/x-log')?.mimeType).toBe('text/plain');
    expect(resolveAllowedType('notes.txt', '')?.mimeType).toBe('text/plain');
    expect(resolveAllowedType('notes.txt', 'application/octet-stream')).toBeNull();
    expect(resolveAllowedType('shot.png', 'image/jpeg')).toBeNull();
    expect(resolveAllowedType('shot.png', 'text/plain')).toBeNull();
  });

  it('refuses anything not on the list, whatever the declared type says', () => {
    expect(resolveAllowedType('payload.exe', 'text/plain')).toBeNull();
    expect(resolveAllowedType('page.html', 'text/html')).toBeNull();
    expect(resolveAllowedType('script.svg', 'image/svg+xml')).toBeNull();
    expect(resolveAllowedType('noext', 'image/png')).toBeNull();
  });
});

describe('InspectingStream', () => {
  it('measures size, hash, head and early NUL in one pass without buffering', async () => {
    const a = Buffer.from('hello ');
    const b = Buffer.from('world, this is more than sixteen bytes');
    const inspection = await inspect(a, b);

    expect(inspection.sizeBytes).toBe(a.length + b.length);
    expect(inspection.sha256).toBe(
      createHash('sha256')
        .update(Buffer.concat([a, b]))
        .digest('hex'),
    );
    expect(inspection.head.toString()).toBe('hello world, thi');
    expect(inspection.sawNul).toBe(false);
  });

  it('flags a NUL in the first 8 KiB but not later', async () => {
    const early = await inspect(Buffer.from('ab\u0000cd'));
    expect(early.sawNul).toBe(true);

    const late = await inspect(Buffer.alloc(8 * 1024, 0x61), Buffer.from([0]));
    expect(late.sawNul).toBe(false);
  });
});

describe('contentMatches', () => {
  it('requires the signature of binary formats, including the split WebP one', async () => {
    const png = await inspect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    expect(contentMatches(type('image/png'), png)).toBe(true);
    expect(contentMatches(type('image/jpeg'), png)).toBe(false);

    const webp = await inspect(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '));
    expect(contentMatches(type('image/webp'), webp)).toBe(true);
    const riffWav = await inspect(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '));
    expect(contentMatches(type('image/webp'), riffWav)).toBe(false);

    const pdf = await inspect(Buffer.from('%PDF-1.7\n'));
    expect(contentMatches(type('application/pdf'), pdf)).toBe(true);
    const html = await inspect(Buffer.from('<html>'));
    expect(contentMatches(type('image/gif'), html)).toBe(false);
  });

  it('accepts text without NUL bytes and refuses empty files', async () => {
    expect(contentMatches(type('text/plain'), await inspect(Buffer.from('ok\n')))).toBe(true);
    expect(contentMatches(type('text/plain'), await inspect(Buffer.from('a\u0000b')))).toBe(false);
    expect(contentMatches(type('text/plain'), await inspect())).toBe(false);
    expect(contentMatches(type('image/png'), await inspect())).toBe(false);
  });
});
