import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { hotp, totpStep } from '../src/modules/auth/mfa/totp';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector, registerAccount } from './utils/workspace';

const PASSWORD = 'Str0ngPassword!';

/**
 * TOTP multi-factor authentication: enrolment, the two-step login, recovery
 * codes, replay and concurrency guarantees, and the organization policy that
 * requires it. MFA is account-level, so most checks are about one user; the
 * policy checks are where tenants meet.
 */
describe('multi-factor authentication', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const post = (url: string, payload: object, token?: string, organizationId?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      payload,
      headers: {
        'x-refresh-transport': 'body',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(organizationId === undefined ? {} : { 'x-organization-id': organizationId }),
      },
    });

  /** The parts of an error a client can compare; the request id always differs. */
  const publicError = (body: { error: { code: string; message: string } }) => ({
    code: body.error.code,
    message: body.error.message,
  });

  const code = (secret: string, offset = 0) => hotp(secret, totpStep(Date.now()) + offset);

  /** Stands in for the next 30-second window, so a fresh code is accepted. */
  const allowNextCode = (userId: string) =>
    prisma.mfaTotpFactor.update({ where: { userId }, data: { lastUsedStep: null } });

  const enrol = async (account: TestAccount) => {
    const setup = await post('/auth/mfa/setup', { password: PASSWORD }, account.accessToken);
    expect(setup.statusCode, setup.body).toBe(200);
    const secret: string = setup.json().secret;
    const confirmed = await post('/auth/mfa/confirm', { code: code(secret) }, account.accessToken);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await allowNextCode(account.userId);
    return { secret, recoveryCodes: confirmed.json().recoveryCodes as string[] };
  };

  const challengeFor = async (email: string): Promise<string> => {
    const response = await post('/auth/login', { email, password: PASSWORD });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().mfaRequired).toBe(true);
    return response.json().challengeToken;
  };

  const signInWithMfa = async (account: TestAccount, secret: string) => {
    const challengeToken = await challengeFor(account.email);
    const response = await post('/auth/mfa/verify', { challengeToken, code: code(secret) });
    expect(response.statusCode, response.body).toBe(200);
    await allowNextCode(account.userId);
    const session: { accessToken: string; refreshToken: string } = response.json();
    return session;
  };

  beforeAll(async () => {
    app = await createTestApp({ authRateLimit: { max: 10_000, windowMs: 60_000 } });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app, { slug: 'mfa' });
  });

  describe('enrolment', () => {
    it('requires the current password and never stores the secret in clear', async () => {
      const owner = workspace.owner;
      const wrong = await post('/auth/mfa/setup', { password: 'not-it-at-all' }, owner.accessToken);
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');

      const setup = await post('/auth/mfa/setup', { password: PASSWORD }, owner.accessToken);
      expect(setup.statusCode).toBe(200);
      const { secret, otpauthUri } = setup.json();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(otpauthUri).toContain(`secret=${secret}`);

      const row = await prisma.mfaTotpFactor.findUniqueOrThrow({ where: { userId: owner.userId } });
      expect(row.secretCiphertext).not.toContain(secret);
      expect(row.confirmedAt).toBeNull();

      const status = await request('GET', '/api/v1/auth/mfa', { token: owner.accessToken });
      expect(status.json()).toMatchObject({ enabled: false, sessionVerified: false });

      // An unconfirmed factor does not change the login.
      const login = await post('/auth/login', { email: owner.email, password: PASSWORD });
      expect(login.json().accessToken).toBeTypeOf('string');
    });

    it('confirms with a valid code, returns the recovery codes once and stores only hashes', async () => {
      const owner = workspace.owner;
      const setup = await post('/auth/mfa/setup', { password: PASSWORD }, owner.accessToken);
      const secret: string = setup.json().secret;

      const bad = await post('/auth/mfa/confirm', { code: code(secret, 5) }, owner.accessToken);
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe('MFA_INVALID_CODE');

      const confirmed = await post('/auth/mfa/confirm', { code: code(secret) }, owner.accessToken);
      expect(confirmed.statusCode).toBe(200);
      const recoveryCodes: string[] = confirmed.json().recoveryCodes;
      expect(recoveryCodes).toHaveLength(10);

      const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: owner.userId } });
      expect(stored).toHaveLength(10);
      for (const row of stored) {
        expect(recoveryCodes).not.toContain(row.codeHash);
      }

      const status = await request('GET', '/api/v1/auth/mfa', { token: owner.accessToken });
      expect(status.json()).toMatchObject({
        enabled: true,
        recoveryCodesRemaining: 10,
        sessionVerified: true,
      });
      expect(JSON.stringify(status.json())).not.toContain(secret);

      // A confirmed factor cannot be silently replaced by a new setup.
      const again = await post('/auth/mfa/setup', { password: PASSWORD }, owner.accessToken);
      expect(again.statusCode).toBe(409);
    });

    it('signs out every other session of the account when MFA is turned on', async () => {
      const owner = workspace.owner;
      const other = await post('/auth/login', { email: owner.email, password: PASSWORD });
      const otherToken: string = other.json().accessToken;
      const otherRefresh: string = other.json().refreshToken;
      expect((await request('GET', '/api/v1/auth/me', { token: otherToken })).statusCode).toBe(200);

      await enrol(owner);

      expect((await request('GET', '/api/v1/auth/me', { token: otherToken })).statusCode).toBe(401);
      expect((await post('/auth/refresh', { refreshToken: otherRefresh })).statusCode).toBe(401);
      expect((await request('GET', '/api/v1/auth/me', { token: owner.accessToken })).statusCode).toBe(
        200,
      );
    });

    it('audits enrolment without secrets and outside any tenant', async () => {
      const owner = workspace.owner;
      const { secret, recoveryCodes } = await enrol(owner);
      await signInWithMfa(owner, secret);
      await post('/auth/mfa/disable', { password: PASSWORD, code: code(secret) }, owner.accessToken);
      const entries = await prisma.auditLog.findMany({
        where: { entityType: 'MfaFactor' },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((entry) => entry.action)).toEqual(['create', 'login', 'delete']);
      for (const entry of entries) {
        expect(entry.organizationId).toBeNull();
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain(secret);
        for (const recovery of recoveryCodes) {
          expect(serialized).not.toContain(recovery);
        }
      }
    });
  });

  describe('two-step login', () => {
    it('returns a challenge instead of a session, then a verified session for a valid code', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);

      const login = await post('/auth/login', { email: owner.email, password: PASSWORD });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toEqual({
        mfaRequired: true,
        challengeToken: expect.any(String),
        expiresIn: 300,
      });
      expect(login.cookies).toHaveLength(0);
      expect(login.json().accessToken).toBeUndefined();

      const stored = await prisma.mfaChallenge.findMany({ where: { userId: owner.userId } });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tokenHash).not.toBe(login.json().challengeToken);

      const verified = await post('/auth/mfa/verify', {
        challengeToken: login.json().challengeToken,
        code: code(secret),
      });
      expect(verified.statusCode, verified.body).toBe(200);
      const status = await request('GET', '/api/v1/auth/mfa', {
        token: verified.json().accessToken,
      });
      expect(status.json().sessionVerified).toBe(true);

      // The refresh token carries the MFA trust forward.
      const refreshed = await post('/auth/refresh', { refreshToken: verified.json().refreshToken });
      expect(refreshed.statusCode).toBe(200);
      const after = await request('GET', '/api/v1/auth/mfa', { token: refreshed.json().accessToken });
      expect(after.json().sessionVerified).toBe(true);
    });

    it('still checks the password first and never reveals whether MFA is on', async () => {
      await enrol(workspace.owner);
      const wrong = await post('/auth/login', { email: workspace.owner.email, password: 'nope-nope-1' });
      const unknown = await post('/auth/login', { email: 'ghost@example.test', password: 'nope-nope-1' });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(publicError(wrong.json())).toEqual(publicError(unknown.json()));
    });

    it('refuses a code from a step that was already used (replay)', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);
      const used = code(secret);
      const first = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(owner.email),
        code: used,
      });
      expect(first.statusCode).toBe(200);

      const replay = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(owner.email),
        code: used,
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('MFA_INVALID_CODE');
    });

    it('consumes a challenge once', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);
      const challengeToken = await challengeFor(owner.email);
      expect((await post('/auth/mfa/verify', { challengeToken, code: code(secret) })).statusCode).toBe(
        200,
      );
      await allowNextCode(owner.userId);

      const again = await post('/auth/mfa/verify', { challengeToken, code: code(secret) });
      expect(again.statusCode).toBe(401);
      expect(again.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('refuses an expired or unknown challenge', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);
      const challengeToken = await challengeFor(owner.email);
      await prisma.mfaChallenge.updateMany({
        where: { userId: owner.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await post('/auth/mfa/verify', { challengeToken, code: code(secret) });
      expect(expired.statusCode).toBe(401);
      expect(expired.json().error.code).toBe('UNAUTHENTICATED');

      const unknown = await post('/auth/mfa/verify', {
        challengeToken: 'x'.repeat(43),
        code: code(secret),
      });
      expect(unknown.statusCode).toBe(401);
      expect(publicError(unknown.json())).toEqual(publicError(expired.json()));
    });

    it('burns the challenge after too many wrong codes and counts them towards the lockout', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);
      const challengeToken = await challengeFor(owner.email);
      const wrong = code(secret, 10);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await post('/auth/mfa/verify', { challengeToken, code: wrong });
        expect(response.json().error.code).toBe('MFA_INVALID_CODE');
      }
      const challenge = await prisma.mfaChallenge.findFirstOrThrow({ where: { userId: owner.userId } });
      expect(challenge.attempts).toBe(5);

      const right = await post('/auth/mfa/verify', { challengeToken, code: code(secret) });
      expect(right.statusCode).toBe(401);
      expect(right.json().error.code).toBe('UNAUTHENTICATED');

      const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
      expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      const login = await post('/auth/login', { email: owner.email, password: PASSWORD });
      expect(login.statusCode).toBe(429);
    });

    it('rejects a request that sends both a code and a recovery code, or neither', async () => {
      const owner = workspace.owner;
      const { secret, recoveryCodes } = await enrol(owner);
      const challengeToken = await challengeFor(owner.email);
      const both = await post('/auth/mfa/verify', {
        challengeToken,
        code: code(secret),
        recoveryCode: recoveryCodes[0],
      });
      const neither = await post('/auth/mfa/verify', { challengeToken });
      expect(both.statusCode).toBe(400);
      expect(neither.statusCode).toBe(400);
    });

    it('lets one of two concurrent verifications of one challenge win', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);
      const challengeToken = await challengeFor(owner.email);
      const current = code(secret);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => post('/auth/mfa/verify', { challengeToken, code: current })),
      );
      expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
      const sessions = await prisma.session.count({
        where: { userId: owner.userId, mfaAuthenticated: true, revokedAt: null },
      });
      // The enrolling session plus exactly one new one.
      expect(sessions).toBe(2);
    });

    it('accepts one TOTP step once even across concurrent challenges', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);
      const challenges = await Promise.all([challengeFor(owner.email), challengeFor(owner.email)]);
      const current = code(secret);
      const results = await Promise.all(
        challenges.map((challengeToken) => post('/auth/mfa/verify', { challengeToken, code: current })),
      );
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    });
  });

  describe('recovery codes', () => {
    it('signs in with a recovery code exactly once', async () => {
      const owner = workspace.owner;
      const { recoveryCodes } = await enrol(owner);
      const recoveryCode = recoveryCodes[0] ?? '';

      const first = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(owner.email),
        recoveryCode: ` ${recoveryCode.toUpperCase()} `,
      });
      expect(first.statusCode, first.body).toBe(200);

      const again = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(owner.email),
        recoveryCode,
      });
      expect(again.statusCode).toBe(401);
      expect(again.json().error.code).toBe('MFA_INVALID_CODE');

      const status = await request('GET', '/api/v1/auth/mfa', { token: first.json().accessToken });
      expect(status.json().recoveryCodesRemaining).toBe(9);
    });

    it('lets one of two concurrent uses of one recovery code win', async () => {
      const owner = workspace.owner;
      const { recoveryCodes } = await enrol(owner);
      const challenges = await Promise.all([challengeFor(owner.email), challengeFor(owner.email)]);
      const results = await Promise.all(
        challenges.map((challengeToken) =>
          post('/auth/mfa/verify', { challengeToken, recoveryCode: recoveryCodes[0] }),
        ),
      );
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    });

    it('regenerates the codes with a TOTP code and invalidates the old ones', async () => {
      const owner = workspace.owner;
      const { secret, recoveryCodes } = await enrol(owner);
      const wrong = await post('/auth/mfa/recovery-codes', { code: code(secret, 7) }, owner.accessToken);
      expect(wrong.statusCode).toBe(401);

      const regenerated = await post('/auth/mfa/recovery-codes', { code: code(secret) }, owner.accessToken);
      expect(regenerated.statusCode).toBe(200);
      const fresh: string[] = regenerated.json().recoveryCodes;
      expect(fresh).toHaveLength(10);
      expect(fresh.some((value) => recoveryCodes.includes(value))).toBe(false);

      const old = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(owner.email),
        recoveryCode: recoveryCodes[1],
      });
      expect(old.statusCode).toBe(401);
      const renewed = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(owner.email),
        recoveryCode: fresh[0],
      });
      expect(renewed.statusCode).toBe(200);
    });

    it("never accepts another user's recovery code", async () => {
      const owner = workspace.owner;
      const other = await registerAccount(app, 'other.mfa@example.test');
      const { recoveryCodes } = await enrol(owner);
      await enrol(other);
      const response = await post('/auth/mfa/verify', {
        challengeToken: await challengeFor(other.email),
        recoveryCode: recoveryCodes[0],
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('MFA_INVALID_CODE');
    });
  });

  describe('disable', () => {
    it('requires password and code, downgrades every session and restores the one-step login', async () => {
      const owner = workspace.owner;
      const { secret } = await enrol(owner);

      const noPassword = await post(
        '/auth/mfa/disable',
        { password: 'wrong-password', code: code(secret) },
        owner.accessToken,
      );
      expect(noPassword.statusCode).toBe(401);
      const noCode = await post(
        '/auth/mfa/disable',
        { password: PASSWORD, code: code(secret, 9) },
        owner.accessToken,
      );
      expect(noCode.statusCode).toBe(401);
      expect(noCode.json().error.code).toBe('MFA_INVALID_CODE');

      const disabled = await post(
        '/auth/mfa/disable',
        { password: PASSWORD, code: code(secret) },
        owner.accessToken,
      );
      expect(disabled.statusCode).toBe(204);

      expect(await prisma.mfaTotpFactor.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: owner.userId } })).toBe(0);
      expect(
        await prisma.session.count({ where: { userId: owner.userId, mfaAuthenticated: true } }),
      ).toBe(0);

      const login = await post('/auth/login', { email: owner.email, password: PASSWORD });
      expect(login.json().accessToken).toBeTypeOf('string');

      const again = await post(
        '/auth/mfa/disable',
        { password: PASSWORD, code: code(secret) },
        owner.accessToken,
      );
      expect(again.statusCode).toBe(409);
    });
  });

  describe('organization policy', () => {
    const requireMfa = (token: string, value: boolean, organizationId = workspace.organizationId) =>
      app.inject({
        method: 'PATCH',
        url: '/api/v1/organizations/current',
        payload: { requireMfa: value },
        headers: { authorization: `Bearer ${token}`, 'x-organization-id': organizationId },
      });

    it('refuses to require MFA from a session that did not pass it', async () => {
      const response = await requireMfa(workspace.owner.accessToken, true);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('MFA_REQUIRED');
      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: workspace.organizationId },
      });
      expect(organization.requireMfa).toBe(false);
    });

    it('lets only the owner change the policy', async () => {
      const admin = await workspace.addMember('organization_admin');
      const { secret } = await enrol(admin);
      const session = await signInWithMfa(admin, secret);
      const response = await requireMfa(session.accessToken, true);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    });

    it('locks members without MFA out of the tenant on the next request, but not out of MFA setup', async () => {
      const tester = await workspace.addMember('tester');
      await enrol(workspace.owner);
      expect((await requireMfa(workspace.owner.accessToken, true)).statusCode).toBe(200);

      const projects = await request('GET', '/api/v1/projects', {
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });
      expect(projects.statusCode).toBe(403);
      expect(projects.json().error.code).toBe('MFA_REQUIRED');

      // Account-level routes stay reachable, so the member can comply.
      const organizations = await request('GET', '/api/v1/organizations', { token: tester.accessToken });
      expect(organizations.statusCode).toBe(200);
      expect(organizations.json()[0]).toMatchObject({ requireMfa: true });

      await enrol(tester);
      const after = await request('GET', '/api/v1/projects', {
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });
      expect(after.statusCode).toBe(200);

      // The owner still works: their session was verified at enrolment.
      const owner = await request('GET', '/api/v1/projects', {
        token: workspace.owner.accessToken,
        organizationId: workspace.organizationId,
      });
      expect(owner.statusCode).toBe(200);
    });

    it('locks a member out again as soon as they disable their factor', async () => {
      const tester = await workspace.addMember('tester');
      await enrol(workspace.owner);
      const { secret } = await enrol(tester);
      await requireMfa(workspace.owner.accessToken, true);

      await post('/auth/mfa/disable', { password: PASSWORD, code: code(secret) }, tester.accessToken);
      const response = await request('GET', '/api/v1/projects', {
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });
      expect(response.json().error.code).toBe('MFA_REQUIRED');
    });

    it('applies only to the organization that requires it', async () => {
      const tester = await workspace.addMember('tester');
      await enrol(workspace.owner);
      await requireMfa(workspace.owner.accessToken, true);

      const ownOrganization = await request('POST', '/api/v1/organizations', {
        token: tester.accessToken,
        payload: { name: 'Side project', slug: 'side-mfa' },
      });
      expect(ownOrganization.statusCode).toBe(201);
      const elsewhere = await request('GET', '/api/v1/projects', {
        token: tester.accessToken,
        organizationId: ownOrganization.json().id,
      });
      expect(elsewhere.statusCode).toBe(200);
    });

    it('answers a non-member with the plain membership refusal, revealing nothing about the policy', async () => {
      await enrol(workspace.owner);
      await requireMfa(workspace.owner.accessToken, true);
      const outsider = await registerAccount(app, 'outsider.mfa@example.test');
      const response = await request('GET', '/api/v1/projects', {
        token: outsider.accessToken,
        organizationId: workspace.organizationId,
      });
      const madeUp = await request('GET', '/api/v1/projects', {
        token: outsider.accessToken,
        organizationId: 'cmnotanorganization000000',
      });
      expect(response.statusCode).toBe(403);
      expect(publicError(response.json())).toEqual(publicError(madeUp.json()));
      expect(response.json().error.code).toBe('FORBIDDEN');
    });

    it('lets the policy be lifted from a verified session and shows who has MFA', async () => {
      const tester = await workspace.addMember('tester');
      await enrol(workspace.owner);
      await requireMfa(workspace.owner.accessToken, true);

      const members = await request('GET', '/api/v1/organizations/current/members', {
        token: workspace.owner.accessToken,
        organizationId: workspace.organizationId,
      });
      const byId = new Map(
        (members.json().data ?? members.json()).map((member: { userId: string; mfaEnabled: boolean }) => [
          member.userId,
          member.mfaEnabled,
        ]),
      );
      expect(byId.get(workspace.owner.userId)).toBe(true);
      expect(byId.get(tester.userId)).toBe(false);

      const lifted = await requireMfa(workspace.owner.accessToken, false);
      expect(lifted.statusCode).toBe(200);
      expect(lifted.json().requireMfa).toBe(false);
      const response = await request('GET', '/api/v1/projects', {
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('rate limiting', () => {
    let limited: NestFastifyApplication;

    beforeAll(async () => {
      limited = await createTestApp({ authRateLimit: { max: 3, windowMs: 60_000 } });
    });

    afterAll(async () => {
      await limited.close();
    });

    it('limits the public verification endpoint like the rest of the auth routes', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await limited.inject({
          method: 'POST',
          url: '/api/v1/auth/mfa/verify',
          payload: { challengeToken: 'y'.repeat(43), code: '123456' },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    });
  });
});
