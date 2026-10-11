import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';

const LIMIT = 3;

/**
 * The public webhook endpoint as the network sees it: behind one trusted
 * proxy hop, with its own per-address budget and a small body limit, and
 * refusing anything unsigned before a row is written.
 */
describe('billing webhook transport', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp({ billingWebhookRateLimitMax: LIMIT, trustProxyHops: 1 });
    prisma = app.get(PrismaService);
    await prisma.truncateAllTables();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (ip: string, payload: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhooks/mock',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload,
    });

  it('refuses a body over 64 KiB with 413 before verifying anything', async () => {
    const huge = JSON.stringify({ padding: 'x'.repeat(70 * 1024) });
    const response = await post('198.51.100.1', huge);
    expect(response.statusCode).toBe(413);
  });

  it('limits each address separately with 429 and Retry-After', async () => {
    const body = JSON.stringify({ id: 'evt_unsigned' });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LIMIT + 2; attempt += 1) {
      statuses.push((await post('198.51.100.2', body)).statusCode);
    }
    expect(statuses).toEqual([400, 400, 400, 429, 429]);
    const limited = await post('198.51.100.2', body);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().error.code).toBe('RATE_LIMITED');

    expect((await post('198.51.100.3', body)).statusCode).toBe(400);
    expect(await prisma.billingWebhookEvent.count()).toBe(0);
  });

  it('admits exactly the budget for a concurrent burst', async () => {
    const body = JSON.stringify({ id: 'evt_burst' });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('198.51.100.4', body)),
    );
    const codes = responses.map((response) => response.statusCode);
    expect(codes.filter((code) => code === 400)).toHaveLength(LIMIT);
    expect(codes.filter((code) => code === 429)).toHaveLength(10 - LIMIT);
  });
});
