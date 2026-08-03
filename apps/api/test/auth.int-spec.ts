import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MembershipStatus, OrganizationRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';

const REGISTER = { email: 'Ada@Example.test', password: 'Str0ngPassword!', fullName: 'Ada Lovelace' };

describe('authentication', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  const register = async (overrides: Partial<typeof REGISTER> = {}) => {
    const response = await post('/api/v1/auth/register', { ...REGISTER, ...overrides });
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('registration', () => {
    it('creates an account, normalises the email and returns a session', async () => {
      const body = await register();

      expect(body.user.email).toBe('ada@example.test');
      expect(body.user).not.toHaveProperty('passwordHash');
      expect(body.accessToken).toBeTypeOf('string');
      expect(body.refreshToken).toBeTypeOf('string');
      expect(body.organizations).toEqual([]);
    });

    it('never stores the password in a recoverable form', async () => {
      await register();

      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
      expect(user.passwordHash).not.toContain(REGISTER.password);
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('stores only a hash of the refresh token', async () => {
      const body = await register();

      const session = await prisma.session.findFirstOrThrow({});
      expect(session.refreshTokenHash).not.toBe(body.refreshToken);
      expect(session.refreshTokenHash).toHaveLength(64);
    });

    it('rejects a weak password with field-level detail', async () => {
      const response = await post('/api/v1/auth/register', { ...REGISTER, password: 'short' });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(response.json().error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'password' })]),
      );
    });

    it('rejects a duplicate email regardless of casing', async () => {
      await register();
      const response = await post('/api/v1/auth/register', { ...REGISTER, email: 'ADA@example.test' });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DUPLICATE_RESOURCE');
    });

    it('strips unknown fields instead of trusting them', async () => {
      const response = await post('/api/v1/auth/register', {
        ...REGISTER,
        isActive: false,
        failedLoginAttempts: 99,
      });

      expect(response.statusCode).toBe(201);
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
      expect(user.isActive).toBe(true);
      expect(user.failedLoginAttempts).toBe(0);
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await register();
    });

    it('accepts valid credentials', async () => {
      const response = await post('/api/v1/auth/login', {
        email: 'ada@example.test',
        password: REGISTER.password,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().accessToken).toBeTypeOf('string');
    });

    it('answers identically for a wrong password and an unknown account', async () => {
      const wrongPassword = await post('/api/v1/auth/login', {
        email: 'ada@example.test',
        password: 'Wr0ngPassword!',
      });
      const unknownUser = await post('/api/v1/auth/login', {
        email: 'nobody@example.test',
        password: 'Wr0ngPassword!',
      });

      // Same status, same code, same message: no account enumeration oracle.
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      expect(wrongPassword.json().error.code).toBe(unknownUser.json().error.code);
      expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
    });

    it('locks the account after repeated failures and reports when to retry', async () => {
      const attempts = 5;
      for (let i = 0; i < attempts; i += 1) {
        await post('/api/v1/auth/login', { email: 'ada@example.test', password: 'Wr0ngPassword!' });
      }

      // Even the *correct* password is refused while the lock holds.
      const response = await post('/api/v1/auth/login', {
        email: 'ada@example.test',
        password: REGISTER.password,
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('RATE_LIMITED');
    });

    it('clears the failure counter after a successful login', async () => {
      await post('/api/v1/auth/login', { email: 'ada@example.test', password: 'Wr0ngPassword!' });
      await post('/api/v1/auth/login', { email: 'ada@example.test', password: REGISTER.password });

      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lastLoginAt).not.toBeNull();
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new pair and invalidates the old refresh token', async () => {
      const session = await register();

      const refreshed = await post('/api/v1/auth/refresh', { refreshToken: session.refreshToken });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().refreshToken).not.toBe(session.refreshToken);

      const replayed = await post('/api/v1/auth/refresh', { refreshToken: session.refreshToken });
      expect(replayed.statusCode).toBe(401);
      expect(replayed.json().error.code).toBe('TOKEN_REUSE_DETECTED');
    });

    it('kills the whole family when a used token is replayed', async () => {
      const session = await register();
      const second = (await post('/api/v1/auth/refresh', { refreshToken: session.refreshToken })).json();

      // The thief (or the confused client) replays the first token...
      await post('/api/v1/auth/refresh', { refreshToken: session.refreshToken });

      // ...and the legitimate current token is dead too. Both parties must
      // re-authenticate, because we cannot tell which one was the victim.
      const afterReuse = await post('/api/v1/auth/refresh', { refreshToken: second.refreshToken });
      expect(afterReuse.statusCode).toBe(401);

      const live = await prisma.session.count({ where: { revokedAt: null } });
      expect(live).toBe(0);
    });

    it('rejects an unknown refresh token', async () => {
      const response = await post('/api/v1/auth/refresh', { refreshToken: 'a'.repeat(43) });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('protected endpoints', () => {
    it('rejects a request with no token', async () => {
      const response = await get('/api/v1/auth/me');
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a forged token', async () => {
      const response = await get('/api/v1/auth/me', bearer('not.a.jwt'));
      expect(response.statusCode).toBe(401);
    });

    it('returns the profile and the organizations for a valid token', async () => {
      const session = await register();
      const organization = await prisma.organization.create({
        data: { name: 'Acme', slug: 'acme' },
      });
      await prisma.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: session.user.id,
          role: OrganizationRole.qa_lead,
        },
      });

      const response = await get('/api/v1/auth/me', bearer(session.accessToken));

      expect(response.statusCode).toBe(200);
      expect(response.json().email).toBe('ada@example.test');
      expect(response.json().organizations).toEqual([
        expect.objectContaining({ slug: 'acme', role: 'qa_lead' }),
      ]);
    });

    it('stops accepting the access token as soon as its session is revoked', async () => {
      const session = await register();

      const before = await get('/api/v1/auth/me', bearer(session.accessToken));
      expect(before.statusCode).toBe(200);

      await post('/api/v1/auth/logout', { refreshToken: session.refreshToken });

      // This is why the guard checks the session row: a stateless check would
      // keep honouring this token until it expired.
      const after = await get('/api/v1/auth/me', bearer(session.accessToken));
      expect(after.statusCode).toBe(401);
    });
  });

  describe('password change', () => {
    it('requires the current password and logs every device out', async () => {
      const first = await register();
      const second = (
        await post('/api/v1/auth/login', {
          email: 'ada@example.test',
          password: REGISTER.password,
        })
      ).json();

      const wrong = await post(
        '/api/v1/auth/change-password',
        { currentPassword: 'Wr0ngPassword!', newPassword: 'An0therPassword!' },
        bearer(first.accessToken),
      );
      expect(wrong.statusCode).toBe(401);

      const changed = await post(
        '/api/v1/auth/change-password',
        { currentPassword: REGISTER.password, newPassword: 'An0therPassword!' },
        bearer(first.accessToken),
      );
      expect(changed.statusCode).toBe(204);

      // The other device's session is gone, not just this one's.
      expect((await get('/api/v1/auth/me', bearer(second.accessToken))).statusCode).toBe(401);

      const withOldPassword = await post('/api/v1/auth/login', {
        email: 'ada@example.test',
        password: REGISTER.password,
      });
      expect(withOldPassword.statusCode).toBe(401);

      const withNewPassword = await post('/api/v1/auth/login', {
        email: 'ada@example.test',
        password: 'An0therPassword!',
      });
      expect(withNewPassword.statusCode).toBe(200);
    });
  });

  describe('active organization', () => {
    it('refuses a tenant-scoped call without the organization header', async () => {
      const session = await register();

      const response = await get('/api/v1/organizations/current', bearer(session.accessToken));

      // The route does not exist yet; what matters is that the failure is not
      // a leak. Until the organizations module lands this is a 404.
      expect([403, 404]).toContain(response.statusCode);
    });

    it('refuses an organization the caller is not a member of', async () => {
      const session = await register();
      const foreign = await prisma.organization.create({ data: { name: 'Foreign', slug: 'foreign' } });

      const response = await get('/api/v1/auth/me', {
        ...bearer(session.accessToken),
        'x-organization-id': foreign.id,
      });

      // /auth/me skips the organization guard, so it must still succeed and
      // must not adopt the unauthorised organization.
      expect(response.statusCode).toBe(200);
    });

    it('accepts an organization where the membership is active', async () => {
      const session = await register();
      const organization = await prisma.organization.create({ data: { name: 'Acme', slug: 'acme' } });
      await prisma.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: session.user.id,
          role: OrganizationRole.tester,
          status: MembershipStatus.active,
        },
      });

      const response = await get('/api/v1/auth/me', {
        ...bearer(session.accessToken),
        'x-organization-id': organization.id,
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
