import { createHash } from 'node:crypto';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { InvitationStatus, OrganizationRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';

const PASSWORD = 'Str0ngPassword!';

/**
 * The membership, invitation and project surface, driven over HTTP.
 *
 * These tests care about the rules that are expensive to get wrong: privilege
 * escalation through the member form, an organization stranded without an
 * owner, an invitation token that survives revocation, and a removed member who
 * still has a valid access token in their hand.
 */
describe('organizations, invitations and projects', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: { payload?: object; token?: string; organizationId?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.organizationId === undefined
          ? {}
          : { 'x-organization-id': options.organizationId }),
      },
    });

  interface Account {
    userId: string;
    email: string;
    accessToken: string;
  }

  const registerAccount = async (email: string, payload: object = {}): Promise<Account> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, fullName: 'Test Person', ...payload },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { userId: body.user.id, email: body.user.email, accessToken: body.accessToken };
  };

  const createOrganization = async (account: Account, slug: string): Promise<string> => {
    const response = await request('POST', '/api/v1/organizations', {
      payload: { name: `Org ${slug}`, slug },
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  };

  const invite = async (
    account: Account,
    organizationId: string,
    email: string,
    role: string,
  ): Promise<{ id: string; token: string }> => {
    const response = await request('POST', '/api/v1/organizations/current/invitations', {
      payload: { email, role },
      token: account.accessToken,
      organizationId,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { id: body.id, token: body.token };
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

  describe('creating and selecting an organization', () => {
    it('makes the creator an owner in the same transaction', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');

      const membership = await prisma.organizationMember.findFirstOrThrow({
        where: { organizationId, userId: owner.userId },
      });
      expect(membership.role).toBe(OrganizationRole.organization_owner);
      expect(membership.deletedAt).toBeNull();
    });

    it('rejects a duplicate slug', async () => {
      const owner = await registerAccount('owner@example.test');
      await createOrganization(owner, 'acme');

      const response = await request('POST', '/api/v1/organizations', {
        payload: { name: 'Another', slug: 'acme' },
        token: owner.accessToken,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DUPLICATE_RESOURCE');
    });

    it('rejects a slug that is not URL-safe instead of silently rewriting it', async () => {
      const owner = await registerAccount('owner@example.test');

      const response = await request('POST', '/api/v1/organizations', {
        payload: { name: 'Acme', slug: 'Acme Corp!' },
        token: owner.accessToken,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].path).toBe('slug');
    });

    it('lists only the organizations the caller belongs to, with their role', async () => {
      const owner = await registerAccount('owner@example.test');
      const stranger = await registerAccount('stranger@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await createOrganization(stranger, 'globex');

      const mine = await request('GET', '/api/v1/organizations', { token: owner.accessToken });

      expect(mine.json()).toEqual([
        expect.objectContaining({ id: organizationId, role: 'organization_owner' }),
      ]);
    });

    it('refuses a request that names an organization the caller does not belong to', async () => {
      const owner = await registerAccount('owner@example.test');
      const stranger = await registerAccount('stranger@example.test');
      const organizationId = await createOrganization(owner, 'acme');

      const response = await request('GET', '/api/v1/projects', {
        token: stranger.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('invitations', () => {
    it('never stores the token in a recoverable form', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');

      const invitation = await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      const row = await prisma.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      expect(row.tokenHash).not.toBe(invitation.token);
      expect(row.tokenHash).toBe(createHash('sha256').update(invitation.token).digest('hex'));
    });

    it('refuses a second pending invitation for the same email', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      const response = await request('POST', '/api/v1/organizations/current/invitations', {
        payload: { email: 'newcomer@example.test', role: 'viewer' },
        token: owner.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DUPLICATE_RESOURCE');
    });

    it('allows the same email to be invited by a different organization', async () => {
      const first = await registerAccount('first@example.test');
      const second = await registerAccount('second@example.test');
      const firstOrg = await createOrganization(first, 'acme');
      const secondOrg = await createOrganization(second, 'globex');

      await invite(first, firstOrg, 'newcomer@example.test', 'tester');
      const response = await request('POST', '/api/v1/organizations/current/invitations', {
        payload: { email: 'newcomer@example.test', role: 'tester' },
        token: second.accessToken,
        organizationId: secondOrg,
      });

      expect(response.statusCode).toBe(201);
    });

    it('refuses to invite somebody who is already a member', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');

      const response = await request('POST', '/api/v1/organizations/current/invitations', {
        payload: { email: owner.email, role: 'tester' },
        token: owner.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(409);
    });

    it('does not offer owner as an invitable role', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');

      const response = await request('POST', '/api/v1/organizations/current/invitations', {
        payload: { email: 'newcomer@example.test', role: 'organization_owner' },
        token: owner.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(400);
    });

    it('lets an existing user accept and grants exactly the invited role', async () => {
      const owner = await registerAccount('owner@example.test');
      const guest = await registerAccount('guest@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, guest.email, 'qa_lead');

      const accepted = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: guest.accessToken,
      });

      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ organizationId, role: 'qa_lead' });

      const membership = await prisma.organizationMember.findFirstOrThrow({
        where: { organizationId, userId: guest.userId },
      });
      expect(membership.role).toBe(OrganizationRole.qa_lead);
    });

    it('lets a brand-new user register and join in a single request', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      const newcomer = await registerAccount('newcomer@example.test', {
        invitationToken: invitation.token,
      });

      const organizations = await request('GET', '/api/v1/organizations', {
        token: newcomer.accessToken,
      });
      expect(organizations.json()).toEqual([
        expect.objectContaining({ id: organizationId, role: 'tester' }),
      ]);
    });

    it('refuses a token issued for a different email address', async () => {
      const owner = await registerAccount('owner@example.test');
      const opportunist = await registerAccount('opportunist@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      const response = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: opportunist.accessToken,
      });

      expect(response.statusCode).toBe(409);
      const membership = await prisma.organizationMember.findFirst({
        where: { organizationId, userId: opportunist.userId },
      });
      expect(membership).toBeNull();
    });

    it('accepts a token exactly once', async () => {
      const owner = await registerAccount('owner@example.test');
      const guest = await registerAccount('guest@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, guest.email, 'tester');

      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: guest.accessToken,
      });
      const second = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: guest.accessToken,
      });

      expect(second.statusCode).toBe(404);
    });

    it('kills the previous token when an invitation is resent', async () => {
      const owner = await registerAccount('owner@example.test');
      const guest = await registerAccount('guest@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const first = await invite(owner, organizationId, guest.email, 'tester');

      const resent = await request(
        'POST',
        `/api/v1/organizations/current/invitations/${first.id}/resend`,
        { token: owner.accessToken, organizationId },
      );
      expect(resent.statusCode).toBe(200);
      expect(resent.json().token).not.toBe(first.token);
      expect(resent.json().resendCount).toBe(1);

      const withOldToken = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: first.token },
        token: guest.accessToken,
      });
      expect(withOldToken.statusCode).toBe(404);

      const withNewToken = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: resent.json().token },
        token: guest.accessToken,
      });
      expect(withNewToken.statusCode).toBe(200);
    });

    it('stops honouring a revoked token', async () => {
      const owner = await registerAccount('owner@example.test');
      const guest = await registerAccount('guest@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, guest.email, 'tester');

      const revoked = await request(
        'DELETE',
        `/api/v1/organizations/current/invitations/${invitation.id}`,
        { token: owner.accessToken, organizationId },
      );
      expect(revoked.statusCode).toBe(204);

      const response = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: guest.accessToken,
      });
      expect(response.statusCode).toBe(404);
    });

    it('allows re-inviting an address whose invitation was revoked', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const first = await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      await request('DELETE', `/api/v1/organizations/current/invitations/${first.id}`, {
        token: owner.accessToken,
        organizationId,
      });

      // This is the case a plain unique index on (organizationId, email) would
      // have broken, and the reason the migration uses a partial one.
      const second = await invite(owner, organizationId, 'newcomer@example.test', 'viewer');
      expect(second.id).not.toBe(first.id);
    });

    it('refuses an expired token and says so distinctly', async () => {
      const owner = await registerAccount('owner@example.test');
      const guest = await registerAccount('guest@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, guest.email, 'tester');

      await prisma.organizationInvitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: guest.accessToken,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain('expired');
    });

    it('lets an unauthenticated invitee preview the invitation before signing up', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      const response = await request(
        'GET',
        `/api/v1/organizations/invitations/preview?token=${invitation.token}`,
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        organizationName: 'Org acme',
        email: 'newcomer@example.test',
        role: 'tester',
      });
    });

    it('answers the same way for an unknown token as for a revoked one', async () => {
      const response = await request(
        'GET',
        '/api/v1/organizations/invitations/preview?token=this-token-was-never-issued-ever',
      );

      expect(response.statusCode).toBe(404);
    });

    it('does not let a tester invite anybody', async () => {
      const owner = await registerAccount('owner@example.test');
      const tester = await registerAccount('tester@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, tester.email, 'tester');
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: tester.accessToken,
      });

      const response = await request('POST', '/api/v1/organizations/current/invitations', {
        payload: { email: 'somebody@example.test', role: 'viewer' },
        token: tester.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('members and roles', () => {
    /** Owner plus an accepted member in the requested role. */
    const organizationWithMember = async (role: string) => {
      const owner = await registerAccount('owner@example.test');
      const member = await registerAccount('member@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, member.email, role);
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: member.accessToken,
      });
      return { owner, member, organizationId };
    };

    it('lists members with their role and paginates', async () => {
      const { organizationId, owner } = await organizationWithMember('tester');

      const response = await request('GET', '/api/v1/organizations/current/members?pageSize=1', {
        token: owner.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meta).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
      expect(response.json().data[0]).not.toHaveProperty('passwordHash');
    });

    it('changes a role and records it in the audit log', async () => {
      const { organizationId, owner, member } = await organizationWithMember('tester');

      const response = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${member.userId}`,
        { payload: { role: 'qa_lead' }, token: owner.accessToken, organizationId },
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ userId: member.userId, role: 'qa_lead' });

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId, action: 'role_change' },
      });
      expect(entry.userId).toBe(owner.userId);
      expect(entry.changes).toMatchObject({ from: 'tester', to: 'qa_lead' });
    });

    it('refuses to let an admin mint an owner', async () => {
      const { organizationId, member, owner } = await organizationWithMember('organization_admin');
      const third = await registerAccount('third@example.test');
      const invitation = await invite(owner, organizationId, third.email, 'tester');
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: third.accessToken,
      });

      const response = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${third.userId}`,
        { payload: { role: 'organization_owner' }, token: member.accessToken, organizationId },
      );

      expect(response.statusCode).toBe(403);
    });

    it('refuses to let an admin touch the owner', async () => {
      const { organizationId, owner, member } = await organizationWithMember('organization_admin');

      const demote = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${owner.userId}`,
        { payload: { role: 'viewer' }, token: member.accessToken, organizationId },
      );
      const remove = await request(
        'DELETE',
        `/api/v1/organizations/current/members/${owner.userId}`,
        { token: member.accessToken, organizationId },
      );

      expect(demote.statusCode).toBe(403);
      expect(remove.statusCode).toBe(403);
    });

    it('refuses to change your own role', async () => {
      const { organizationId, owner } = await organizationWithMember('tester');

      const response = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${owner.userId}`,
        { payload: { role: 'viewer' }, token: owner.accessToken, organizationId },
      );

      expect(response.statusCode).toBe(403);
    });

    it('never leaves the organization without an owner', async () => {
      const owner = await registerAccount('owner@example.test');
      const second = await registerAccount('second@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, second.email, 'organization_admin');
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: second.accessToken,
      });

      // Promote the second person to owner, then let them demote the first.
      await request('PATCH', `/api/v1/organizations/current/members/${second.userId}`, {
        payload: { role: 'organization_owner' },
        token: owner.accessToken,
        organizationId,
      });
      const demoteFirst = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${owner.userId}`,
        { payload: { role: 'viewer' }, token: second.accessToken, organizationId },
      );
      expect(demoteFirst.statusCode).toBe(200);

      // Now only one owner is left, and nothing may demote or remove them.
      const third = await registerAccount('third@example.test');
      const thirdInvite = await invite(second, organizationId, third.email, 'organization_admin');
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: thirdInvite.token },
        token: third.accessToken,
      });
      const demoteLastOwner = await request(
        'PATCH',
        `/api/v1/organizations/current/members/${second.userId}`,
        { payload: { role: 'viewer' }, token: third.accessToken, organizationId },
      );

      expect(demoteLastOwner.statusCode).toBe(403);
    });

    it('cuts a removed member off immediately, with their access token still in hand', async () => {
      const { organizationId, owner, member } = await organizationWithMember('tester');

      const before = await request('GET', '/api/v1/projects', {
        token: member.accessToken,
        organizationId,
      });
      expect(before.statusCode).toBe(200);

      const removed = await request(
        'DELETE',
        `/api/v1/organizations/current/members/${member.userId}`,
        { token: owner.accessToken, organizationId },
      );
      expect(removed.statusCode).toBe(204);

      // Same token, same header, no membership: this is why the guard reads the
      // database instead of trusting a claim inside the JWT.
      const after = await request('GET', '/api/v1/projects', {
        token: member.accessToken,
        organizationId,
      });
      expect(after.statusCode).toBe(403);
    });

    it('keeps the removed membership row so history still resolves', async () => {
      const { organizationId, owner, member } = await organizationWithMember('tester');

      await request('DELETE', `/api/v1/organizations/current/members/${member.userId}`, {
        token: owner.accessToken,
        organizationId,
      });

      const row = await prisma.organizationMember.findFirstOrThrow({
        where: { organizationId, userId: member.userId },
      });
      expect(row.deletedAt).not.toBeNull();
    });

    it('re-activates the old row when a removed member is invited back', async () => {
      const { organizationId, owner, member } = await organizationWithMember('tester');
      await request('DELETE', `/api/v1/organizations/current/members/${member.userId}`, {
        token: owner.accessToken,
        organizationId,
      });

      const again = await invite(owner, organizationId, member.email, 'viewer');
      const accepted = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: again.token },
        token: member.accessToken,
      });

      expect(accepted.statusCode).toBe(200);
      const rows = await prisma.organizationMember.findMany({
        where: { organizationId, userId: member.userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe(OrganizationRole.viewer);
      expect(rows[0]?.deletedAt).toBeNull();
    });
  });

  describe('projects', () => {
    const ownerWithOrganization = async (slug = 'acme') => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, slug);
      return { owner, organizationId };
    };

    const createProject = async (
      owner: Account,
      organizationId: string,
      payload: object = { name: 'Website', key: 'WEB' },
    ) => request('POST', '/api/v1/projects', { payload, token: owner.accessToken, organizationId });

    it('creates a project with an uppercase key', async () => {
      const { owner, organizationId } = await ownerWithOrganization();

      const response = await createProject(owner, organizationId, {
        name: 'Website',
        key: 'web',
        description: 'Public site',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ key: 'WEB', status: 'active' });
    });

    it('rejects a duplicate key inside the organization', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      await createProject(owner, organizationId);

      const response = await createProject(owner, organizationId);

      expect(response.statusCode).toBe(409);
    });

    it('lets a different organization use the same key', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      await createProject(owner, organizationId);
      const other = await registerAccount('other@example.test');
      const otherOrganization = await createOrganization(other, 'globex');

      const response = await createProject(other, otherOrganization);

      expect(response.statusCode).toBe(201);
    });

    it('filters and paginates', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      await createProject(owner, organizationId, { name: 'Website', key: 'WEB' });
      await createProject(owner, organizationId, { name: 'Mobile app', key: 'MOB' });

      const filtered = await request('GET', '/api/v1/projects?search=mobile&pageSize=10', {
        token: owner.accessToken,
        organizationId,
      });

      expect(filtered.json().data).toHaveLength(1);
      expect(filtered.json().data[0].key).toBe('MOB');
      expect(filtered.json().meta.total).toBe(1);
    });

    it('rejects a page size above the maximum instead of honouring it', async () => {
      const { owner, organizationId } = await ownerWithOrganization();

      const response = await request('GET', '/api/v1/projects?pageSize=100000', {
        token: owner.accessToken,
        organizationId,
      });

      expect(response.statusCode).toBe(400);
    });

    it('archives, refuses edits while archived, and restores', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const projectId = (await createProject(owner, organizationId)).json().id;

      const archived = await request('POST', `/api/v1/projects/${projectId}/archive`, {
        token: owner.accessToken,
        organizationId,
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ status: 'archived' });
      expect(archived.json().archivedAt).not.toBeNull();

      const edit = await request('PATCH', `/api/v1/projects/${projectId}`, {
        payload: { name: 'Renamed' },
        token: owner.accessToken,
        organizationId,
      });
      expect(edit.statusCode).toBe(409);

      const restored = await request('POST', `/api/v1/projects/${projectId}/restore`, {
        token: owner.accessToken,
        organizationId,
      });
      expect(restored.json()).toMatchObject({ status: 'active', archivedAt: null });
    });

    it('hides another organization behind a 404, not a 403', async () => {
      const { owner, organizationId } = await ownerWithOrganization();
      const projectId = (await createProject(owner, organizationId)).json().id;
      const other = await registerAccount('other@example.test');
      const otherOrganization = await createOrganization(other, 'globex');

      const response = await request('GET', `/api/v1/projects/${projectId}`, {
        token: other.accessToken,
        organizationId: otherOrganization,
      });

      expect(response.statusCode).toBe(404);
    });

    it('lets a viewer read but not create', async () => {
      const owner = await registerAccount('owner@example.test');
      const viewer = await registerAccount('viewer@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, viewer.email, 'viewer');
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: viewer.accessToken,
      });

      const read = await request('GET', '/api/v1/projects', {
        token: viewer.accessToken,
        organizationId,
      });
      const write = await createProject(viewer, organizationId);

      expect(read.statusCode).toBe(200);
      expect(write.statusCode).toBe(403);
    });

    it('drops fields the caller is not allowed to set', async () => {
      const { owner, organizationId } = await ownerWithOrganization();

      const response = await createProject(owner, organizationId, {
        name: 'Website',
        key: 'WEB',
        status: 'archived',
        testCaseCounter: 900,
        organizationId: 'somebody-elses-organization',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe('active');
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: response.json().id },
      });
      expect(project.organizationId).toBe(organizationId);
      expect(project.testCaseCounter).toBe(0);
    });
  });

  describe('audit log', () => {
    it('records who did what, from where, in which organization', async () => {
      const owner = await registerAccount('owner@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      await request('POST', '/api/v1/projects', {
        payload: { name: 'Website', key: 'WEB' },
        token: owner.accessToken,
        organizationId,
      });

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId, entityType: 'Project', action: 'create' },
      });

      expect(entry.userId).toBe(owner.userId);
      expect(entry.summary).toContain('WEB');
      expect(entry.requestId).not.toBeNull();
    });

    it('writes nothing when the operation was refused', async () => {
      const owner = await registerAccount('owner@example.test');
      const opportunist = await registerAccount('opportunist@example.test');
      const organizationId = await createOrganization(owner, 'acme');
      const invitation = await invite(owner, organizationId, 'newcomer@example.test', 'tester');

      const refused = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.token },
        token: opportunist.accessToken,
      });
      expect(refused.statusCode).toBe(409);

      // The invitation is still pending and no acceptance was recorded: the
      // membership, the state transition and the audit entry share one
      // transaction, so a rejected acceptance leaves no trace of having half
      // happened.
      expect(await prisma.auditLog.count({ where: { action: 'accept_invite' } })).toBe(0);
      const row = await prisma.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      expect(row.status).toBe(InvitationStatus.pending);
    });
  });
});
