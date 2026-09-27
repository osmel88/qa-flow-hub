import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { StorageError } from '../errors';
import { StorageProvider, StoredObjectInfo, isSafeStorageKey } from './storage-provider';

/**
 * Objects in a `Map`. Nothing touches the disk, nothing survives a restart.
 *
 * It exists so unit tests of the attachments service can run without a
 * filesystem and so a failure can be scripted (`failNext`) without stubbing
 * `fs`. Selected with `STORAGE_PROVIDER=memory`; never a deployment choice.
 */
@Injectable()
export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory';
  private readonly objects = new Map<string, Buffer>();
  private pendingFailure: StorageError | null = null;

  /** The next operation, whatever it is, throws this error instead. */
  failNext(operation: 'put' | 'get' | 'head' | 'delete'): void {
    this.pendingFailure = new StorageError(operation, new Error('simulated failure'));
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  clear(): void {
    this.objects.clear();
    this.pendingFailure = null;
  }

  async put(key: string, body: Readable, _options: { contentType: string }): Promise<void> {
    this.check(key);
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    if (this.objects.has(key)) {
      throw new StorageError('put', new Error('key already exists'));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  get(key: string): Promise<Readable | null> {
    return this.checked(key, () => {
      const object = this.objects.get(key);
      return object === undefined ? null : Readable.from([object]);
    });
  }

  head(key: string): Promise<StoredObjectInfo | null> {
    return this.checked(key, () => {
      const object = this.objects.get(key);
      return object === undefined ? null : { sizeBytes: object.byteLength };
    });
  }

  delete(key: string): Promise<void> {
    return this.checked(key, () => {
      this.objects.delete(key);
    });
  }

  private checked<T>(key: string, operation: () => T): Promise<T> {
    try {
      this.check(key);
      return Promise.resolve(operation());
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private check(key: string): void {
    if (this.pendingFailure !== null) {
      const failure = this.pendingFailure;
      this.pendingFailure = null;
      throw failure;
    }
    if (!isSafeStorageKey(key)) {
      throw new StorageError('head', new Error('Unsafe storage key rejected'));
    }
  }
}
