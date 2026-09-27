import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { StorageError } from '../errors';
import { StorageProvider, StoredObjectInfo, isSafeStorageKey } from './storage-provider';

type StorageOperation = 'put' | 'get' | 'head' | 'delete';

/**
 * Objects as files under one root directory.
 *
 * It is the whole provider for development and single-node deployments, and
 * it is also the reference for what an S3 provider must honour: the key is
 * resolved against the root and the result is checked to still be inside
 * it, so even a key that slipped past `isSafeStorageKey` cannot leave the
 * tree. Errors are wrapped into `StorageError` with the filesystem detail
 * kept for the log and out of the response.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root: string;

  constructor(config: AppConfigService) {
    this.root = resolve(config.storage.localRoot);
  }

  /** `contentType` is unused here: a filesystem has no such header. S3 will. */
  async put(key: string, body: Readable, _options: { contentType: string }): Promise<void> {
    const path = this.pathFor('put', key);
    try {
      await mkdir(dirname(path), { recursive: true });
      // `wx`: fail if the file exists. Keys are single-use; a collision means a
      // bug upstream, and silently overwriting evidence is worse than a 503.
      await pipeline(body, createWriteStream(path, { flags: 'wx' }));
    } catch (error: unknown) {
      // Clean up our own partial file — but never the object that already
      // owned the key when `wx` refused to open it.
      if (!hasCode(error, 'EEXIST')) {
        await rm(path, { force: true }).catch(() => undefined);
      }
      throw this.wrap('put', error);
    }
  }

  async get(key: string): Promise<Readable | null> {
    const path = this.pathFor('get', key);
    const info = await this.head(key);
    if (info === null) {
      return null;
    }
    return createReadStream(path);
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    const path = this.pathFor('head', key);
    try {
      const info = await stat(path);
      return info.isFile() ? { sizeBytes: info.size } : null;
    } catch (error: unknown) {
      if (isMissing(error)) {
        return null;
      }
      throw this.wrap('head', error);
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor('delete', key);
    try {
      await rm(path, { force: true });
    } catch (error: unknown) {
      throw this.wrap('delete', error);
    }
  }

  /**
   * Key → absolute path, refusing anything that would resolve outside the
   * root. Both checks run on every call: the grammar catches `..` and odd
   * characters; the prefix check catches whatever the grammar did not foresee.
   */
  private pathFor(operation: StorageOperation, key: string): string {
    if (!isSafeStorageKey(key)) {
      throw this.wrap(operation, new Error('Unsafe storage key rejected'));
    }
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) {
      throw this.wrap(operation, new Error('Storage key resolves outside the root'));
    }
    return path;
  }

  private wrap(operation: StorageOperation, error: unknown): StorageError {
    this.logger.error(
      `Local storage ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return error instanceof StorageError ? error : new StorageError(operation, error);
  }
}

function isMissing(error: unknown): boolean {
  return hasCode(error, 'ENOENT');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
