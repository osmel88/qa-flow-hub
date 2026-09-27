import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { StorageError } from '../errors';
import { LocalStorageProvider } from './local-storage.provider';
import { MemoryStorageProvider } from './memory-storage.provider';
import { StorageProvider, isSafeStorageKey } from './storage-provider';

const KEY = 'org/clorg/project/clproj/test_result/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.png';

async function read(stream: Readable): Promise<string> {
  let out = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    out += chunk.toString();
  }
  return out;
}

describe('isSafeStorageKey', () => {
  it('accepts the generated shape and nothing that could be a path', () => {
    expect(isSafeStorageKey(KEY)).toBe(true);
    expect(isSafeStorageKey('org/a/project/b/defect/x.log')).toBe(true);

    expect(isSafeStorageKey('../etc/passwd')).toBe(false);
    expect(isSafeStorageKey('org/../../x.png')).toBe(false);
    expect(isSafeStorageKey('/org/a/x.png')).toBe(false);
    expect(isSafeStorageKey('org/a/x.png/')).toBe(false);
    expect(isSafeStorageKey('org//a/x.png')).toBe(false);
    expect(isSafeStorageKey('org/a/x')).toBe(false);
    expect(isSafeStorageKey('org/a/Shot.PNG')).toBe(false);
    expect(isSafeStorageKey('org/a/x y.png')).toBe(false);
    expect(isSafeStorageKey(`org/${'a'.repeat(600)}/x.png`)).toBe(false);
  });
});

/** The contract every provider must honour; the same block runs against each. */
function behavesLikeAStorageProvider(name: string, make: () => Promise<StorageProvider>) {
  describe(`${name} contract`, () => {
    let storage: StorageProvider;

    beforeEach(async () => {
      storage = await make();
    });

    it('puts, heads, gets and deletes by key, idempotently', async () => {
      expect(await storage.head(KEY)).toBeNull();
      expect(await storage.get(KEY)).toBeNull();

      await storage.put(KEY, Readable.from([Buffer.from('evidence')]), {
        contentType: 'image/png',
      });
      expect(await storage.head(KEY)).toEqual({ sizeBytes: 8 });
      const body = await storage.get(KEY);
      expect(body).not.toBeNull();
      expect(await read(body as Readable)).toBe('evidence');

      await storage.delete(KEY);
      await storage.delete(KEY);
      expect(await storage.head(KEY)).toBeNull();
    });

    it('never overwrites: keys are single use', async () => {
      await storage.put(KEY, Readable.from([Buffer.from('first')]), { contentType: 'image/png' });
      await expect(
        storage.put(KEY, Readable.from([Buffer.from('second')]), { contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(await read((await storage.get(KEY)) as Readable)).toBe('first');
    });

    it('refuses unsafe keys on every operation', async () => {
      for (const key of ['../x.png', 'org/a/../b.png', '/abs.png']) {
        await expect(storage.head(key)).rejects.toBeInstanceOf(StorageError);
        await expect(storage.get(key)).rejects.toBeInstanceOf(StorageError);
        await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageError);
        await expect(
          storage.put(key, Readable.from([Buffer.from('x')]), { contentType: 'text/plain' }),
        ).rejects.toBeInstanceOf(StorageError);
      }
    });
  });
}

describe('LocalStorageProvider', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'qa-flow-hub-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const make = async () =>
    new LocalStorageProvider({
      storage: { provider: 'local', localRoot: root, maxSizeBytes: 1024 },
    } as unknown as AppConfigService);

  behavesLikeAStorageProvider('local', make);

  it('writes under the root using the key as the relative path', async () => {
    const storage = await make();
    await storage.put(KEY, Readable.from([Buffer.from('bytes')]), { contentType: 'image/png' });
    expect(await readFile(join(root, KEY), 'utf8')).toBe('bytes');
  });

  it('leaves no partial file when the body fails mid-stream', async () => {
    const storage = await make();
    const failing = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('client went away'));
      },
    });
    await expect(
      storage.put(KEY, failing, { contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(await storage.head(KEY)).toBeNull();
  });

  it('does not report directories as objects', async () => {
    const storage = await make();
    await writeFile(join(root, 'marker'), '');
    expect(await storage.head('org/a/marker.txt')).toBeNull();
  });
});

describe('MemoryStorageProvider', () => {
  behavesLikeAStorageProvider('memory', async () => new MemoryStorageProvider());

  it('can script one failure for the next call', async () => {
    const storage = new MemoryStorageProvider();
    storage.failNext('put');
    await expect(
      storage.put(KEY, Readable.from([Buffer.from('x')]), { contentType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR', httpStatus: 503 });
    await storage.put(KEY, Readable.from([Buffer.from('x')]), { contentType: 'image/png' });
    expect(storage.has(KEY)).toBe(true);
  });
});
