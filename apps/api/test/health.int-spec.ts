import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './utils/create-test-app';

describe('Health endpoints (integration)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the liveness probe without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('answers the readiness probe with one status per dependency and no detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'ok' },
        migrations: { status: 'ok', pending: 0, failed: 0 },
        storage: { status: 'ok' },
        // The integration suites connect as the table owner: a warning
        // outside production, a refusal to boot inside it.
        databaseRole: { status: 'warn' },
      },
    });
    expect(response.body).not.toMatch(/postgres|qaflow|storage-test|5433/i);
  });

  it('does not expose metrics unless they are enabled', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('sends the security headers and a deny-everything content security policy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('answers CORS preflights for configured origins only', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/login',
        headers: { origin, 'access-control-request-method': 'POST' },
      });

    const allowed = await preflight('http://localhost:5173');
    const foreign = await preflight('https://evil.example');

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes a well-formed request id and replaces a malformed one', async () => {
    const kept = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { 'x-request-id': 'edge-trace-0001' },
    });
    const replaced = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { 'x-request-id': 'bad id with spaces' },
    });

    expect(kept.headers['x-request-id']).toBe('edge-trace-0001');
    expect(kept.json().error.requestId).toBe('edge-trace-0001');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.json().error.requestId).toBe(replaced.headers['x-request-id']);
  });

  it('keeps the real status of framework errors: 415 and 413 are not 500', async () => {
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/xml' },
      payload: '<login/>',
    });
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(1_100_000) }),
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });

    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ error: { requestId: expect.any(String) } });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBeDefined();
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR');
  });
});
