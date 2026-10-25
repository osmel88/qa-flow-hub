import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hotp, totpStep } from '../src/modules/auth/mfa/totp';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

const PASSWORD = 'Str0ngPassword!';

/**
 * MFA with the API connected as `qaflow_app`, the role production uses, so
 * `audit_logs` is under Row Level Security. MFA writes audit entries without
 * an organization inside its transactions; this is where a policy that only
 * the runtime role is subject to would turn enrolment into a 500.
 */
describe('multi-factor authentication under the runtime database role', () => {
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

  const code = (secret: string) => hotp(secret, totpStep(Date.now()));

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({ databaseUrl: appRoleUrl() });
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

  it('enrols, signs in, regenerates codes and turns MFA off, auditing each step', async () => {
    const account = acme.owner;
    const setup = await post('/auth/mfa/setup', { password: PASSWORD }, account.accessToken);
    expect(setup.statusCode, setup.body).toBe(200);
    const secret: string = setup.json().secret;

    const confirm = await post('/auth/mfa/confirm', { code: code(secret) }, account.accessToken);
    expect(confirm.statusCode, confirm.body).toBe(200);
    const recoveryCodes: string[] = confirm.json().recoveryCodes;

    const login = await post('/auth/login', { email: account.email, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
    const verify = await post('/auth/mfa/verify', {
      challengeToken: login.json().challengeToken,
      recoveryCode: recoveryCodes[0],
    });
    expect(verify.statusCode, verify.body).toBe(200);
    const token: string = verify.json().accessToken;

    await owner.mfaTotpFactor.update({
      where: { userId: account.userId },
      data: { lastUsedStep: null },
    });
    const regenerate = await post('/auth/mfa/recovery-codes', { code: code(secret) }, token);
    expect(regenerate.statusCode, regenerate.body).toBe(200);

    await owner.mfaTotpFactor.update({
      where: { userId: account.userId },
      data: { lastUsedStep: null },
    });
    const disable = await post('/auth/mfa/disable', { password: PASSWORD, code: code(secret) }, token);
    expect(disable.statusCode, disable.body).toBe(204);

    const entries = await owner.auditLog.findMany({
      where: { entityType: 'MfaFactor', userId: account.userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'login', 'update', 'delete']);
    expect(entries.every((entry) => entry.organizationId === null)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('keeps organization-less audit entries invisible to every tenant', async () => {
    const setup = await post('/auth/mfa/setup', { password: PASSWORD }, acme.owner.accessToken);
    const secret: string = setup.json().secret;
    const confirm = await post('/auth/mfa/confirm', { code: code(secret) }, acme.owner.accessToken);
    expect(confirm.statusCode, confirm.body).toBe(200);

    const audit = await request('GET', '/api/v1/audit-log', {
      token: acme.owner.accessToken,
      organizationId: acme.organizationId,
    });
    expect(audit.statusCode, audit.body).toBe(200);
    const listed: Array<{ entityType: string }> = audit.json().data;
    expect(listed.some((entry) => entry.entityType === 'MfaFactor')).toBe(false);
  });

  it('enforces the organization policy under Row Level Security', async () => {
    const setup = await post('/auth/mfa/setup', { password: PASSWORD }, acme.owner.accessToken);
    const secret: string = setup.json().secret;
    const confirm = await post('/auth/mfa/confirm', { code: code(secret) }, acme.owner.accessToken);
    expect(confirm.statusCode, confirm.body).toBe(200);

    const policy = await request('PATCH', '/api/v1/organizations/current', {
      payload: { requireMfa: true },
      token: acme.owner.accessToken,
      organizationId: acme.organizationId,
    });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().requireMfa).toBe(true);

    const member = await acme.addMember('tester');
    const blocked = await request('GET', '/api/v1/projects', {
      token: member.accessToken,
      organizationId: acme.organizationId,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MFA_REQUIRED');
  });
});
