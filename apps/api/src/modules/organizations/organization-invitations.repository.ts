import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InvitationStatus, OrganizationInvitation, OrganizationRole } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';

export interface IssuedInvitationToken {
  token: string;
  tokenHash: string;
}

/**
 * Hashes an invitation token for storage and for lookup.
 *
 * SHA-256 rather than Argon2, and unsalted on purpose: the token is 256 bits
 * from a CSPRNG, so there is nothing to brute-force and no dictionary to
 * defend against. An unsalted hash is also *required* here, because acceptance
 * has to find the row **by** the hash — a per-row salt would make the lookup
 * impossible without scanning every invitation.
 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueInvitationToken(): IssuedInvitationToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

/**
 * Constant-time comparison of two hex hashes. The database lookup is already
 * exact-match, so this only matters for the defence-in-depth path where a hash
 * we hold is compared in application code.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Not a `TenantAwareRepository`, and this is the interesting part: acceptance
 * happens *before* the accepting user has any membership in the organization,
 * so there is no active tenant to scope by. The token is the authorization.
 *
 * Everything else here is scoped explicitly by an `organizationId` the guard
 * already validated, which is why those methods take one.
 */
@Injectable()
export class OrganizationInvitationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPending(organizationId: string, email: string): Promise<OrganizationInvitation | null> {
    return this.prisma.organizationInvitation.findFirst({
      where: { organizationId, email, status: InvitationStatus.pending },
    });
  }

  findById(organizationId: string, id: string): Promise<OrganizationInvitation | null> {
    return this.prisma.organizationInvitation.findFirst({ where: { organizationId, id } });
  }

  /** Lookup by token hash. Deliberately not scoped: the token identifies the org. */
  findByTokenHash(tokenHash: string): Promise<OrganizationInvitation | null> {
    return this.prisma.organizationInvitation.findUnique({ where: { tokenHash } });
  }

  listForOrganization(
    organizationId: string,
    statuses?: InvitationStatus[],
  ): Promise<OrganizationInvitation[]> {
    return this.prisma.organizationInvitation.findMany({
      where: {
        organizationId,
        ...(statuses === undefined ? {} : { status: { in: statuses } }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(
    data: {
      organizationId: string;
      email: string;
      role: OrganizationRole;
      tokenHash: string;
      expiresAt: Date;
      invitedById: string;
    },
    tx?: PrismaTransaction,
  ): Promise<OrganizationInvitation> {
    return (tx ?? this.prisma).organizationInvitation.create({ data });
  }

  /**
   * Replaces the token of a pending invitation and bumps the resend counter.
   *
   * A resend issues a *new* token and invalidates the old one, rather than
   * re-sending the same string. If the first message leaked, the resend is the
   * moment to stop honouring it.
   */
  async refreshToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<OrganizationInvitation | null> {
    const { count } = await this.prisma.organizationInvitation.updateMany({
      where: { id, status: InvitationStatus.pending },
      data: { tokenHash, expiresAt, resendCount: { increment: 1 }, lastSentAt: new Date() },
    });
    return count === 0 ? null : this.prisma.organizationInvitation.findUnique({ where: { id } });
  }

  /** Revokes a pending invitation. Returns false if it was not pending. */
  async revoke(organizationId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.organizationInvitation.updateMany({
      where: { organizationId, id, status: InvitationStatus.pending },
      data: { status: InvitationStatus.revoked, revokedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Marks an invitation accepted, but only if it is still pending — the
   * `status` in the filter is what makes a double acceptance impossible even if
   * two requests arrive at the same instant. Returns false when somebody else
   * won the race.
   */
  async markAccepted(id: string, userId: string, tx: PrismaTransaction): Promise<boolean> {
    const { count } = await tx.organizationInvitation.updateMany({
      where: { id, status: InvitationStatus.pending },
      data: {
        status: InvitationStatus.accepted,
        acceptedAt: new Date(),
        acceptedByUserId: userId,
      },
    });
    return count > 0;
  }

  /**
   * Flips expired invitations to `expired`.
   *
   * Acceptance never trusts this to have run: it checks `expiresAt` itself. The
   * transition exists so that the members screen can show an honest status
   * without every read computing it, and so the partial unique index stops
   * blocking a re-invite once the old one has lapsed.
   */
  async expireOverdue(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.organizationInvitation.updateMany({
      where: { status: InvitationStatus.pending, expiresAt: { lt: now } },
      data: { status: InvitationStatus.expired },
    });
    return count;
  }
}
