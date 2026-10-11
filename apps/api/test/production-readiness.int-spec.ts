import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { AppLifecycleService } from '../src/modules/health/app-lifecycle.service';
import { JsonLogger } from '../src/observability/app-logger';
import { STORAGE_PROVIDER, StorageProvider } from '../src/storage/storage-provider';
import { createTestApp } from './utils/create-test-app';
import { createWorkspace } from './utils/workspace';

const METRICS_TOKEN = 'Pm3nV7bX1zQ9wE5rT2yU8iO4pA6sD0fG';
const AUTH_LIMIT = 3;
const PASSWORD = 'Str0ngPassword!';

/**
 * S2-F10: the operational contract of a production instance — rate limits,
 * request correlation, logs, metrics and readiness — exercised through the
 * same `configureApp` that `main.ts` runs, behind one trusted proxy hop.
 */
describe('production readiness (integration)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const lines: string[] = [];

  beforeAll(async () => {
    app = await createTestApp({
      authRateLimit: { max: AUTH_LIMIT, windowMs: 60_000 },
      metrics: { enabled: true, token: METRICS_TOKEN },
      trustProxyHops: 1,
      logger: new JsonLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    prisma = app.get(PrismaService);
    await prisma.truncateAllTables();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (clientIp: string, email = 'nobody@example.test') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': clientIp, 'x-refresh-transport': 'body' },
      payload: { email, password: 'Wr0ngPassword!' },
    });

  describe('rate limiting', () => {
    it('limits credential endpoints per client address with RATE_LIMITED and Retry-After', async () => {
      for (let attempt = 0; attempt < AUTH_LIMIT; attempt += 1) {
        expect((await login('203.0.113.10', `user${attempt}@example.test`)).statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.10', 'x-request-id': 'limited-req-0001' },
        payload: { email: 'nobody@example.test', password: 'Wr0ngPassword!' },
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: expect.stringMatching(/Too many requests/),
          requestId: 'limited-req-0001',
        },
      });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['x-request-id']).toBe('limited-req-0001');
    });

    it('shares the budget between login, registration and refresh', async () => {
      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'x-forwarded-for': '203.0.113.10' },
        payload: { email: 'new@example.test', password: PASSWORD, fullName: 'New Person' },
      });
      const refresh = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'x-forwarded-for': '203.0.113.10', 'x-refresh-transport': 'body' },
        payload: { refreshToken: 'whatever' },
      });

      expect(register.statusCode).toBe(429);
      expect(refresh.statusCode).toBe(429);
    });

    it('keys on the address the trusted proxy saw, not on what the client wrote', async () => {
      // The client prepends a fresh address; the proxy appends the real one.
      const spoofed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10' },
        payload: { email: 'nobody@example.test', password: 'Wr0ngPassword!' },
      });
      const otherClient = await login('203.0.113.11');

      expect(spoofed.statusCode).toBe(429);
      expect(otherClient.statusCode).toBe(401);
    });

    it('admits exactly the budget when the attempts arrive at the same time', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          login('203.0.113.50', `burst${index}@example.test`),
        ),
      );
      const statuses = attempts.map((response) => response.statusCode);

      expect(statuses.filter((status) => status === 401)).toHaveLength(AUTH_LIMIT);
      expect(statuses.filter((status) => status === 429)).toHaveLength(12 - AUTH_LIMIT);
    });

    it('does not spend the stricter budget on other routes, nor limit the probes', async () => {
      const browsing = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      const probe = await app.inject({
        method: 'GET',
        url: '/health/ready',
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });

      expect(browsing.statusCode).not.toBe(429);
      expect(probe.statusCode).toBe(200);
      expect(probe.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });

  describe('request correlation', () => {
    it('uses one request id and one client address for the header, the error and the audit row', async () => {
      const workspace = await createWorkspace(app, { slug: 'corr', emailPrefix: 'corr' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: {
          authorization: `Bearer ${workspace.owner.accessToken}`,
          'x-request-id': 'audit-trace-0001',
          'x-forwarded-for': '198.51.100.7, 203.0.113.50',
        },
        payload: { name: 'Second org', slug: 'corr-second' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['x-request-id']).toBe('audit-trace-0001');

      const audit = await prisma.auditLog.findFirst({ where: { requestId: 'audit-trace-0001' } });
      expect(audit).not.toBeNull();
      expect(audit?.ipAddress).toBe('203.0.113.50');
    });
  });

  describe('logs', () => {
    it('writes one JSON request line per request with the route template and no credentials', async () => {
      lines.length = 0;
      const workspace = await createWorkspace(app, { slug: 'logs', emailPrefix: 'logs' });
      await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${workspace.projectId}?token=query-secret-value`,
        headers: {
          authorization: `Bearer ${workspace.owner.accessToken}`,
          'x-organization-id': workspace.organizationId,
          cookie: 'qf_refresh=cookie-secret-value',
          'x-request-id': 'log-trace-0001',
        },
      });

      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const requestLine = parsed.find((line) => line['requestId'] === 'log-trace-0001');

      expect(requestLine).toMatchObject({
        level: 'info',
        context: 'HTTP',
        msg: 'request completed',
        method: 'GET',
        route: '/api/v1/projects/:id',
        statusCode: 200,
      });
      expect(typeof requestLine?.['durationMs']).toBe('number');

      const everything = lines.join('\n');
      expect(everything).not.toContain(workspace.owner.accessToken);
      expect(everything).not.toContain('cookie-secret-value');
      expect(everything).not.toContain('query-secret-value');
      expect(everything).not.toContain(PASSWORD);
      expect(everything).not.toContain(workspace.projectId);
    });
  });

  describe('metrics', () => {
    it('refuses a scrape without the token', async () => {
      const missing = await app.inject({ method: 'GET', url: '/metrics' });
      const wrong = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer not-the-token' },
      });

      expect(missing.statusCode).toBe(401);
      expect(missing.json().error.code).toBe('UNAUTHENTICATED');
      expect(wrong.statusCode).toBe(401);
    });

    it('exposes Prometheus series labelled by route template, never by tenant or entity', async () => {
      const workspace = await createWorkspace(app, { slug: 'metrics', emailPrefix: 'metrics' });
      await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${workspace.projectId}`,
        headers: {
          authorization: `Bearer ${workspace.owner.accessToken}`,
          'x-organization-id': workspace.organizationId,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain(
        'http_requests_total{method="GET",route="/api/v1/projects/:id",status="200"}',
      );
      expect(response.body).toContain('http_request_duration_seconds_bucket');
      expect(response.body).toContain('status="429"');
      expect(response.body).not.toContain(workspace.projectId);
      expect(response.body).not.toContain(workspace.organizationId);
      expect(response.body).not.toContain(workspace.owner.userId);
    });
  });

  describe('readiness', () => {
    it('answers 503 when the database does not respond', async () => {
      const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('connection refused'));
      try {
        const response = await app.inject({ method: 'GET', url: '/health/ready' });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          status: 'not_ready',
          checks: { database: { status: 'fail' }, migrations: { status: 'fail' } },
        });
        expect(response.body).not.toContain('connection refused');
      } finally {
        spy.mockRestore();
      }
    });

    it('answers 503 when a migration shipped with the code is not applied', async () => {
      const spy = vi
        .spyOn(prisma, '$queryRaw')
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([]);
      try {
        const response = await app.inject({ method: 'GET', url: '/health/ready' });

        expect(response.statusCode).toBe(503);
        expect(response.json().checks.migrations).toMatchObject({ status: 'fail', failed: 0 });
        expect(response.json().checks.migrations.pending).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('answers 503 when storage cannot be written', async () => {
      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const spy = vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('EACCES /var/storage'));
      try {
        const response = await app.inject({ method: 'GET', url: '/health/ready' });

        expect(response.statusCode).toBe(503);
        expect(response.json().checks.storage.status).toBe('fail');
        expect(response.body).not.toContain('EACCES');
      } finally {
        spy.mockRestore();
      }
    });

    it('runs one check for a burst of concurrent probes, so the probe cannot be used to flood storage', async () => {
      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const put = vi.spyOn(storage, 'put');
      try {
        const responses = await Promise.all(
          Array.from({ length: 25 }, () => app.inject({ method: 'GET', url: '/health/ready' })),
        );

        expect(responses.map((response) => response.statusCode)).toEqual(Array(25).fill(200));
        expect(put).toHaveBeenCalledTimes(1);
      } finally {
        put.mockRestore();
      }
    });

    it('leaves no probe object behind', async () => {
      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const put = vi.spyOn(storage, 'put');
      try {
        await app.inject({ method: 'GET', url: '/health/ready' });
        const key = put.mock.calls[0]?.[0];

        expect(key).toMatch(/^health\/readiness-[0-9a-f-]+\.probe$/);
        expect(await storage.head(key as string)).toBeNull();
      } finally {
        put.mockRestore();
      }
    });

    // Last: draining cannot be undone, by design.
    it('answers 503 while draining after SIGTERM, with liveness still 200', async () => {
      app.get(AppLifecycleService).beginDraining();

      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      const live = await app.inject({ method: 'GET', url: '/health' });

      expect(ready.statusCode).toBe(503);
      expect(ready.json().status).toBe('draining');
      expect(live.statusCode).toBe(200);
    });
  });
});
