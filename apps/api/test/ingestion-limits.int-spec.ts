import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * The per-project key cap and the per-key ingestion rate limit, on an app
 * booted with low limits. Kept apart from `ingestion.int-spec.ts`, whose app
 * runs with limits high enough not to interfere with the other cases.
 */
describe('API keys and report ingestion: limits', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;

  const request = injector(() => app);

  const ownerUrl = (): string =>
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';

  const appRoleUrl = (): string => {
    const url = new URL(ownerUrl());
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const truncate = async (): Promise<void> => {
    const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    const list = tables.map((row) => `"${row.tablename}"`).join(', ');
    await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" ENABLE TRIGGER USER`);
    }
  };

  const as = (account: TestAccount, payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: acme.organizationId,
  });

  const createKey = (name: string) =>
    request('POST', `/api/v1/projects/${acme.projectId}/api-keys`, as(acme.owner, { name }));

  const ingest = (token: string, content: string) => {
    const boundary = 'qa-flow-hub-ingest';
    return app.inject({
      method: 'POST',
      url: '/api/v1/ingest/junit',
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.xml"\r\n\r\n` +
          `${content}\r\n--${boundary}--\r\n`,
      ),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  const REPORT = '<testsuites><testsuite name="s"><testcase name="t"/></testsuite></testsuites>';

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({
      databaseUrl: appRoleUrl(),
      ingestion: { rateLimitMax: 2, maxActiveKeysPerProject: 2 },
    });
  });

  beforeEach(async () => {
    await truncate();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
  });

  afterAll(async () => {
    await truncate();
    await app.close();
    await owner.$disconnect();
  });

  it('caps active keys per project, also under concurrent creation; revoked keys free a slot', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((name) => createKey(name)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.json().error.code).toBe('CONFLICT');
    expect(await owner.apiKey.count()).toBe(2);

    const id = results.find((r) => r.statusCode === 201)!.json().key.id;
    await request(
      'POST',
      `/api/v1/projects/${acme.projectId}/api-keys/${id}/revoke`,
      as(acme.owner),
    );
    expect((await createKey('e')).statusCode).toBe(201);
  });

  it('refuses new keys on an archived project', async () => {
    await owner.project.update({
      where: { id: acme.projectId },
      data: { status: 'archived', archivedAt: new Date() },
    });
    expect((await createKey('x')).statusCode).toBe(409);
    expect(await owner.apiKey.count()).toBe(0);
  });

  it('rate limits ingestion per key, separately from other keys', async () => {
    const first = (await createKey('one')).json().token as string;
    const second = (await createKey('two')).json().token as string;
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await ingest(first, `${REPORT}${' '.repeat(index)}`)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect((await ingest(second, `${REPORT}\n`)).statusCode).toBe(200);
    expect(await owner.ingestionReport.count()).toBe(3);
  });
});
