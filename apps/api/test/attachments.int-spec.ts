import { createHash } from 'node:crypto';
import { access, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AttachmentView } from '@qa-flow-hub/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { StorageError } from '../src/errors';
import { LocalStorageProvider } from '../src/storage/local-storage.provider';
import { STORAGE_PROVIDER } from '../src/storage/storage-provider';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('not really a picture but the header says so'),
]);
const TEXT = Buffer.from('2026-07-31T10:00:00Z ERROR checkout: card declined\n');
const MAX_BYTES = Number(process.env['UPLOAD_MAX_SIZE_BYTES']);

interface Multipart {
  payload: Buffer;
  contentType: string;
}

/** A single-file multipart body built by hand, so nothing but the API is under test. */
function multipart(fileName: string, mimeType: string, content: Buffer): Multipart {
  const boundary = 'qa-flow-hub-test-boundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('attachments (evidence uploads)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: LocalStorageProvider;
  let workspace: TestWorkspace;
  let tester: TestAccount;
  let viewer: TestAccount;
  let runId: string;
  let resultId: string;
  let defectId: string;
  let testCaseId: string;

  const request = injector(() => app);
  const storageRoot = resolve(process.env['STORAGE_LOCAL_ROOT'] ?? './var/storage');

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
  });

  const upload = (
    account: TestAccount,
    target: { entityType: string; entityId: string },
    file: Multipart,
    organizationId?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/attachments?entityType=${target.entityType}&entityId=${target.entityId}`,
      payload: file.payload,
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        'x-organization-id': organizationId ?? workspace.organizationId,
        'content-type': file.contentType,
      },
    });

  const uploadOk = async (
    account: TestAccount,
    target: { entityType: string; entityId: string },
    file: Multipart = multipart('screenshot.png', 'image/png', PNG),
  ): Promise<AttachmentView> => {
    const response = await upload(account, target, file);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AttachmentView>();
  };

  const list = (account: TestAccount, target: { entityType: string; entityId: string }) =>
    request(
      'GET',
      `/api/v1/attachments?entityType=${target.entityType}&entityId=${target.entityId}`,
      as(account),
    );

  const storedFiles = async (): Promise<string[]> => {
    try {
      await access(storageRoot);
    } catch {
      return [];
    }
    return readdir(storageRoot, { recursive: true }).then((entries) =>
      entries.filter((entry) => /\.[a-z0-9]+$/.test(entry)),
    );
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    storage = app.get<LocalStorageProvider>(STORAGE_PROVIDER);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await rm(storageRoot, { recursive: true, force: true });
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
    tester = await workspace.addMember('tester');
    viewer = await workspace.addMember('viewer');

    const suite = (
      await request(
        'POST',
        '/api/v1/test-suites',
        as(workspace.owner, { projectId: workspace.projectId, name: 'Checkout' }),
      )
    ).json();
    testCaseId = (
      await request(
        'POST',
        '/api/v1/test-cases',
        as(workspace.owner, { suiteId: suite.id, title: 'Pay with a valid card' }),
      )
    ).json().id;
    runId = (
      await request(
        'POST',
        '/api/v1/test-runs',
        as(workspace.owner, {
          projectId: workspace.projectId,
          name: 'Sprint 12 regression',
          selection: { testCaseIds: [testCaseId] },
        }),
      )
    ).json().id;
    const runCaseId = (await request('GET', `/api/v1/test-runs/${runId}/cases`, as(tester))).json()
      .data[0].id;
    resultId = (
      await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        as(tester, { status: 'failed', notes: 'Card declined with a valid card' }),
      )
    ).json().id;
    defectId = (
      await request(
        'POST',
        '/api/v1/defects',
        as(tester, { projectId: workspace.projectId, title: 'Card declined' }),
      )
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('limits', () => {
    it('publishes the accepted types, the size limit and the provider', async () => {
      const response = await request('GET', '/api/v1/attachments/limits', as(viewer));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        maxSizeBytes: MAX_BYTES,
        allowedMimeTypes: expect.arrayContaining(['image/png', 'text/plain', 'application/pdf']),
        allowedExtensions: expect.arrayContaining(['png', 'txt', 'log', 'json', 'pdf']),
        storageProvider: 'local',
      });
    });
  });

  describe('upload', () => {
    it('stores the bytes behind the provider and only metadata in PostgreSQL', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });

      expect(view).toMatchObject({
        projectId: workspace.projectId,
        entityType: 'test_result',
        entityId: resultId,
        fileName: 'screenshot.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
        checksum: createHash('sha256').update(PNG).digest('hex'),
        uploadedById: tester.userId,
        uploadedByName: 'Test Person',
        contentPath: `/attachments/${view.id}/content`,
      });
      expect(view).not.toHaveProperty('storageKey');

      const row = await prisma.attachmentMetadata.findUniqueOrThrow({ where: { id: view.id } });
      expect(row.organizationId).toBe(workspace.organizationId);
      expect(row.storageProvider).toBe('local');
      expect(row.storageKey).toMatch(
        new RegExp(
          `^org/${workspace.organizationId}/project/${workspace.projectId}/test_result/[0-9a-f-]{36}\\.png$`,
        ),
      );
      expect(row.storageKey).not.toContain('screenshot');

      const files = await storedFiles();
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(row.storageKey);
    });

    it('accepts defects, runs and cases as targets', async () => {
      await uploadOk(tester, { entityType: 'defect', entityId: defectId });
      await uploadOk(
        workspace.owner,
        { entityType: 'test_run', entityId: runId },
        multipart('console.log', 'text/plain', TEXT),
      );
      await uploadOk(
        workspace.owner,
        { entityType: 'test_case', entityId: testCaseId },
        multipart('fixture.json', 'application/json', Buffer.from('{"card":"4242"}')),
      );
      expect(await storedFiles()).toHaveLength(3);
    });

    it('rejects a type outside the allow-list before storing anything', async () => {
      const response = await upload(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('payload.exe', 'application/octet-stream', Buffer.from('MZ')),
      );
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
      expect(await storedFiles()).toHaveLength(0);
      expect(await prisma.attachmentMetadata.count()).toBe(0);
    });

    it('rejects an extension that disagrees with the declared type', async () => {
      const response = await upload(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('script.html', 'image/png', PNG),
      );
      expect(response.statusCode).toBe(415);
    });

    it('rejects bytes that disagree with the declared image type and removes the object', async () => {
      const response = await upload(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('fake.png', 'image/png', Buffer.from('<script>alert(1)</script>')),
      );
      expect(response.statusCode).toBe(415);
      expect(await storedFiles()).toHaveLength(0);
      expect(await prisma.attachmentMetadata.count()).toBe(0);
    });

    it('rejects text files that are really binary', async () => {
      const response = await upload(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('dump.txt', 'text/plain', Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01])),
      );
      expect(response.statusCode).toBe(415);
    });

    it('rejects a file over the configured limit and leaves no partial object', async () => {
      const big = Buffer.alloc(MAX_BYTES + 1, 0x61);
      const response = await upload(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('huge.txt', 'text/plain', big),
      );
      expect(response.statusCode).toBe(413);
      expect(response.json().error).toMatchObject({
        code: 'FILE_TOO_LARGE',
        message: `File exceeds the maximum size of ${MAX_BYTES} bytes`,
      });
      expect(await storedFiles()).toHaveLength(0);
      expect(await prisma.attachmentMetadata.count()).toBe(0);
    });

    it('never uses the client file name for the path', async () => {
      const view = await uploadOk(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('../../../../etc/passwd.txt', 'text/plain', TEXT),
      );
      expect(view.fileName).toBe('passwd.txt');

      const files = await storedFiles();
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain('..');
      expect(files[0]).not.toContain('etc');
      await expect(access(resolve(storageRoot, '../etc/passwd.txt'))).rejects.toThrow();
    });

    it('requires a multipart body with a file part', async () => {
      const response = await request(
        'POST',
        `/api/v1/attachments?entityType=test_result&entityId=${resultId}`,
        as(tester, { file: 'not-a-file' }),
      );
      expect(response.statusCode).toBe(400);
    });

    it('answers 404 for an unknown or deleted target without hinting which', async () => {
      const unknown = await upload(
        tester,
        { entityType: 'test_result', entityId: 'clzzzzzzzzzzzzzzzzzzzzzzz' },
        multipart('a.png', 'image/png', PNG),
      );
      expect(unknown.statusCode).toBe(404);

      await request('DELETE', `/api/v1/defects/${defectId}`, as(workspace.owner));
      const deleted = await upload(
        workspace.owner,
        { entityType: 'defect', entityId: defectId },
        multipart('a.png', 'image/png', PNG),
      );
      expect(deleted.statusCode).toBe(404);

      await request('DELETE', `/api/v1/test-runs/${runId}`, as(workspace.owner));
      const orphanResult = await upload(
        workspace.owner,
        { entityType: 'test_result', entityId: resultId },
        multipart('a.png', 'image/png', PNG),
      );
      expect(orphanResult.statusCode).toBe(404);
    });

    it('is refused to viewers', async () => {
      const response = await upload(
        viewer,
        { entityType: 'test_result', entityId: resultId },
        multipart('a.png', 'image/png', PNG),
      );
      expect(response.statusCode).toBe(403);
      expect(await storedFiles()).toHaveLength(0);
    });

    it('is audited with metadata but never with content or storage paths', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      const audit = await prisma.auditLog.findMany({
        where: { entityType: 'Attachment', entityId: view.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'create',
        userId: tester.userId,
        organizationId: workspace.organizationId,
      });
      const serialized = JSON.stringify(audit[0]);
      expect(serialized).toContain('screenshot.png');
      expect(serialized).not.toContain('org/');
      expect(serialized).not.toContain('not really a picture');
    });

    it('surfaces a provider failure as 503 without leaving metadata behind', async () => {
      vi.spyOn(storage, 'put').mockRejectedValueOnce(
        new StorageError('put', new Error('disk full')),
      );
      const response = await upload(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('a.png', 'image/png', PNG),
      );
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('STORAGE_ERROR');
      expect(response.body).not.toContain('disk full');
      expect(await prisma.attachmentMetadata.count()).toBe(0);
    });
  });

  describe('list and metadata', () => {
    it('lists only the active evidence of the requested entity', async () => {
      const first = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      await uploadOk(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('console.log', 'text/plain', TEXT),
      );
      await uploadOk(tester, { entityType: 'defect', entityId: defectId });

      const response = await list(viewer, { entityType: 'test_result', entityId: resultId });
      expect(response.statusCode).toBe(200);
      const rows = response.json().data as AttachmentView[];
      expect(rows.map((row) => row.fileName)).toEqual(['screenshot.png', 'console.log']);

      const one = await request('GET', `/api/v1/attachments/${first.id}`, as(viewer));
      expect(one.statusCode).toBe(200);
      expect(one.json()).toEqual(first);
    });

    it('rejects an unknown entity type in the query', async () => {
      const response = await request(
        'GET',
        `/api/v1/attachments?entityType=requirement&entityId=${resultId}`,
        as(viewer),
      );
      expect(response.statusCode).toBe(400);
    });
  });

  describe('download', () => {
    it('streams the bytes with the server-chosen disposition and no static path', async () => {
      const view = await uploadOk(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('notas finales (v2) ñ.txt', 'text/plain', TEXT),
      );

      const download = await request('GET', `/api/v1/attachments/${view.id}/content`, as(viewer));
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toBe('text/plain');
      expect(download.headers['content-length']).toBe(String(TEXT.byteLength));
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['cache-control']).toBe('private, no-store');
      expect(download.headers['content-disposition']).toBe(
        `attachment; filename="notas finales (v2) _.txt"; filename*=UTF-8''notas%20finales%20%28v2%29%20%C3%B1.txt`,
      );
      expect(download.rawPayload.equals(TEXT)).toBe(true);
    });

    it('renders images inline on request but never text', async () => {
      const image = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      const text = await uploadOk(
        tester,
        { entityType: 'test_result', entityId: resultId },
        multipart('a.txt', 'text/plain', TEXT),
      );

      const inlineImage = await request(
        'GET',
        `/api/v1/attachments/${image.id}/content?disposition=inline`,
        as(viewer),
      );
      expect(inlineImage.headers['content-disposition']).toMatch(/^inline;/);

      const inlineText = await request(
        'GET',
        `/api/v1/attachments/${text.id}/content?disposition=inline`,
        as(viewer),
      );
      expect(inlineText.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('answers 404 when the metadata exists but the object is gone', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      const row = await prisma.attachmentMetadata.findUniqueOrThrow({ where: { id: view.id } });
      await storage.delete(row.storageKey);

      const download = await request('GET', `/api/v1/attachments/${view.id}/content`, as(viewer));
      expect(download.statusCode).toBe(404);
      expect(download.json().error.code).toBe('NOT_FOUND');
    });

    it('requires authentication and an organization', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      const anonymous = await app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${view.id}/content`,
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('delete', () => {
    it('is logical in PostgreSQL and physical in the provider, and audited', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      expect(await storedFiles()).toHaveLength(1);

      const response = await request('DELETE', `/api/v1/attachments/${view.id}`, as(tester));
      expect(response.statusCode).toBe(204);

      const row = await prisma.attachmentMetadata.findUniqueOrThrow({ where: { id: view.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(await storedFiles()).toHaveLength(0);

      const listed = await list(viewer, { entityType: 'test_result', entityId: resultId });
      expect(listed.json().data).toEqual([]);
      const gone = await request('GET', `/api/v1/attachments/${view.id}/content`, as(viewer));
      expect(gone.statusCode).toBe(404);
      const again = await request('DELETE', `/api/v1/attachments/${view.id}`, as(tester));
      expect(again.statusCode).toBe(404);

      const audit = await prisma.auditLog.findMany({
        where: { entityType: 'Attachment', entityId: view.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual(['create', 'delete']);
    });

    it('keeps the row when the provider fails, so nothing is lost silently', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      vi.spyOn(storage, 'delete').mockRejectedValueOnce(
        new StorageError('delete', new Error('bucket unreachable')),
      );

      const response = await request('DELETE', `/api/v1/attachments/${view.id}`, as(tester));
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('STORAGE_ERROR');
      expect(response.body).not.toContain('bucket unreachable');

      const row = await prisma.attachmentMetadata.findUniqueOrThrow({ where: { id: view.id } });
      expect(row.deletedAt).toBeNull();
      expect(await storedFiles()).toHaveLength(1);
    });

    it('lets the uploader and project leads delete, nobody else', async () => {
      const otherTester = await workspace.addMember('tester', 'tester2');
      const mine = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      const theirs = await uploadOk(otherTester, { entityType: 'test_result', entityId: resultId });

      expect(
        (await request('DELETE', `/api/v1/attachments/${theirs.id}`, as(tester))).statusCode,
      ).toBe(403);
      expect(
        (await request('DELETE', `/api/v1/attachments/${mine.id}`, as(viewer))).statusCode,
      ).toBe(403);
      expect(
        (await request('DELETE', `/api/v1/attachments/${mine.id}`, as(tester))).statusCode,
      ).toBe(204);
      expect(
        (await request('DELETE', `/api/v1/attachments/${theirs.id}`, as(workspace.owner)))
          .statusCode,
      ).toBe(204);
    });
  });

  describe('tenant isolation', () => {
    it('hides another organization’s evidence from list, read, download, delete and upload', async () => {
      const view = await uploadOk(tester, { entityType: 'test_result', entityId: resultId });
      const other = await createWorkspace(app, { emailPrefix: 'rival', slug: 'rival' });

      const listed = await request(
        'GET',
        `/api/v1/attachments?entityType=test_result&entityId=${resultId}`,
        as(other.owner, undefined, other.organizationId),
      );
      expect(listed.statusCode).toBe(404);

      for (const url of [
        `/api/v1/attachments/${view.id}`,
        `/api/v1/attachments/${view.id}/content`,
      ]) {
        const response = await request(
          'GET',
          url,
          as(other.owner, undefined, other.organizationId),
        );
        expect(response.statusCode, url).toBe(404);
      }

      const removed = await request(
        'DELETE',
        `/api/v1/attachments/${view.id}`,
        as(other.owner, undefined, other.organizationId),
      );
      expect(removed.statusCode).toBe(404);

      const uploaded = await upload(
        other.owner,
        { entityType: 'test_result', entityId: resultId },
        multipart('a.png', 'image/png', PNG),
        other.organizationId,
      );
      expect(uploaded.statusCode).toBe(404);

      expect(await prisma.attachmentMetadata.count({ where: { deletedAt: null } })).toBe(1);
    });

    it('does not let a member use a foreign organization header', async () => {
      const other = await createWorkspace(app, { emailPrefix: 'rival', slug: 'rival' });
      const response = await request(
        'GET',
        `/api/v1/attachments?entityType=test_result&entityId=${resultId}`,
        as(tester, undefined, other.organizationId),
      );
      expect(response.statusCode).toBe(403);
    });
  });
});
