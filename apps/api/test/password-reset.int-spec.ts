import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/database/prisma.service';
import { MockEmailAdapter } from '../src/integrations/email-mock/email-mock.adapter';
import { hashResetToken } from '../src/modules/auth/password-reset.service';
import { createTestApp } from './utils/create-test-app';

const ACCOUNT = {
  email: 'ada@example.test',
  password: 'Str0ngPassword!',
  fullName: 'Ada Lovelace',
};
const NEW_PASSWORD = 'N3wPassword!!x';

/**
 * Password recovery, booted as the runtime role (`qaflow_app`) because the
 * audit entries it writes have no organization and live under RLS.
 */
describe('password reset', () => {
  let app: NestFastifyApplication;
  /** Owner connection: truncation and direct assertions only. */
  let ownerApp: NestFastifyApplication;
  let prisma: PrismaService;
  let outbox: MockEmailAdapter;

  const appRoleUrl = (): string => {
    const url = new URL(
      process.env['TEST_DATABASE_URL'] ??
        'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public',
    );
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const post = (target: NestFastifyApplication, url: string, payload: object) =>
    target.inject({ method: 'POST', url, payload, headers: { 'x-refresh-transport': 'body' } });

  const register = async () => {
    const response = await post(app, '/api/v1/auth/register', ACCOUNT);
    expect(response.statusCode).toBe(201);
    return response.json<{ refreshToken: string; user: { id: string } }>();
  };

  const forgot = (email: string, target = app) =>
    post(target, '/api/v1/auth/password/forgot', { email });

  const tokenOf = (url: string): string => new URL(url).searchParams.get('token') ?? '';

  const requestLink = async (): Promise<string> => {
    const response = await forgot(ACCOUNT.email);
    expect(response.statusCode).toBe(202);
    const url = response.json<{ mockResetUrl: string }>().mockResetUrl;
    expect(url).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
    return tokenOf(url);
  };

  const reset = (token: string, newPassword = NEW_PASSWORD) =>
    post(app, '/api/v1/auth/password/reset', { token, newPassword });

  const login = (password: string) =>
    post(app, '/api/v1/auth/login', { email: ACCOUNT.email, password });

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: appRoleUrl() });
    ownerApp = await createTestApp();
    prisma = ownerApp.get(PrismaService);
    outbox = app.get(MockEmailAdapter);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    outbox.reset();
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
    await ownerApp.close();
  });

  it('answers the same way for unknown, inactive and real accounts', async () => {
    const { user } = await register();
    const unknown = await forgot('nobody@example.test');
    const known = await forgot(ACCOUNT.email);
    expect(unknown.statusCode).toBe(202);
    expect(known.statusCode).toBe(202);
    expect(Object.keys(unknown.json<object>())).toEqual(Object.keys(known.json<object>()));
    expect(unknown.json()).toEqual({ accepted: true, mockResetUrl: null });

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await forgot(ACCOUNT.email)).json()).toEqual({ accepted: true, mockResetUrl: null });
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it('stores only a hash, emails the link and never exposes it in production', async () => {
    const { user } = await register();
    const token = await requestLink();

    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(hashResetToken(token));
    expect(row.tokenHash).not.toContain(token);
    const ttlMinutes = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
    expect(Math.round(ttlMinutes)).toBe(30);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: 'password_reset' },
    });
    expect(notification).toMatchObject({
      organizationId: null,
      recipientUserId: user.id,
      status: 'sent',
    });
    expect(outbox.find(notification.id)?.text).toContain(`token=${token}`);
    expect(JSON.stringify(notification.metadata)).not.toContain(token);

    const config = app.get(AppConfigService);
    const production = vi.spyOn(config, 'isProduction', 'get').mockReturnValue(true);
    try {
      const response = await forgot(ACCOUNT.email);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
      expect(response.body).not.toContain('token');
    } finally {
      production.mockRestore();
    }
  });

  it('resets the password once, revokes every session and audits the change', async () => {
    const { refreshToken, user } = await register();
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 3 } });
    const token = await requestLink();

    expect((await reset(token)).statusCode).toBe(204);

    const refreshed = await post(app, '/api/v1/auth/refresh', { refreshToken });
    expect(refreshed.statusCode).toBe(401);
    expect(
      await prisma.session.count({ where: { userId: user.id, revokedReason: 'password_reset' } }),
    ).toBe(1);
    expect((await login(ACCOUNT.password)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginAttempts,
    ).toBe(0);

    const reused = await reset(token, 'An0therPassword!');
    expect(reused.statusCode).toBe(400);
    expect(reused.body).toMatch(/invalid or has expired/);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);

    const audit = await prisma.auditLog.findMany({
      where: { action: 'password_reset', entityId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((entry) => entry.summary)).toEqual([
      'Password reset link requested',
      'Password reset with a recovery link; every session was revoked',
    ]);
    expect(audit.every((entry) => entry.organizationId === null)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(await prisma.notification.count({ where: { type: 'password_changed' } })).toBe(1);
  });

  it('refuses expired, superseded, unknown and malformed tokens', async () => {
    await register();
    const first = await requestLink();
    const second = await requestLink();
    expect((await reset(first)).statusCode).toBe(400);

    await prisma.passwordResetToken.updateMany({
      where: { tokenHash: hashResetToken(second) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await reset(second)).statusCode).toBe(400);
    expect((await reset('x'.repeat(43))).statusCode).toBe(400);
    expect((await reset('short')).statusCode).toBe(400);
    expect((await login(ACCOUNT.password)).statusCode).toBe(200);
  });

  it('keeps the token alive when the new password breaks the policy', async () => {
    await register();
    const token = await requestLink();
    expect((await reset(token, 'weak')).statusCode).toBe(400);
    expect((await reset(token)).statusCode).toBe(204);
  });

  it('lets only one of two concurrent resets with the same token win', async () => {
    await register();
    const token = await requestLink();
    const results = await Promise.all([
      reset(token, 'Concurr3ntOne!'),
      reset(token, 'Concurr3ntTwo!'),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([204, 400]);
    const winner = results[0]?.statusCode === 204 ? 'Concurr3ntOne!' : 'Concurr3ntTwo!';
    expect((await login(winner)).statusCode).toBe(200);
  });

  it('issues at most three links per account per window, silently', async () => {
    await register();
    for (let index = 0; index < 3; index += 1) {
      await requestLink();
    }
    const throttled = await forgot(ACCOUNT.email);
    expect(throttled.statusCode).toBe(202);
    expect(throttled.json()).toEqual({ accepted: true, mockResetUrl: null });
    expect(await prisma.passwordResetToken.count()).toBe(3);
    expect(await prisma.notification.count({ where: { type: 'password_reset' } })).toBe(3);
  });

  it('shares the per-IP authentication rate limit', async () => {
    const limited = await createTestApp({
      databaseUrl: appRoleUrl(),
      authRateLimit: { max: 2, windowMs: 60_000 },
    });
    try {
      expect((await forgot('a@example.test', limited)).statusCode).toBe(202);
      expect((await forgot('b@example.test', limited)).statusCode).toBe(202);
      expect((await forgot('c@example.test', limited)).statusCode).toBe(429);
      const resetLimited = await post(limited, '/api/v1/auth/password/reset', {
        token: 'x'.repeat(43),
        newPassword: NEW_PASSWORD,
      });
      expect(resetLimited.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
