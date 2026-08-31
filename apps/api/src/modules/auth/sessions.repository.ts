import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Session } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';

export interface CreateSessionInput {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  /** Absent for a fresh login; carried over when rotating. */
  familyId?: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Sessions are the only tenant-*less* functional table: a session belongs to a
 * person, not to an organization, because one login gives access to every
 * organization that person is a member of. That is why this repository does not
 * extend TenantAwareRepository.
 */
@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateSessionInput, tx?: PrismaTransaction): Promise<Session> {
    const client = tx ?? this.prisma;
    return client.session.create({
      data: {
        userId: input.userId,
        refreshTokenHash: input.refreshTokenHash,
        // A new login starts a new family; a rotation stays in its own.
        familyId: input.familyId ?? randomUUID(),
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  findByTokenHash(refreshTokenHash: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { refreshTokenHash } });
  }

  findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  listActiveForUser(userId: string): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Atomically replaces a session with its successor in the same family.
   *
   * Both writes must land together: revoking without creating logs the user
   * out, and creating without revoking leaves two live refresh tokens, which
   * is exactly what rotation exists to prevent.
   */
  rotate(
    previous: Session,
    refreshTokenHash: string,
    next: { expiresAt: Date; ipAddress?: string | undefined; userAgent?: string | undefined },
  ): Promise<Session> {
    return this.prisma.runInTransaction(async (tx) => {
      const created = await this.create(
        {
          userId: previous.userId,
          refreshTokenHash,
          familyId: previous.familyId,
          expiresAt: next.expiresAt,
          ipAddress: next.ipAddress,
          userAgent: next.userAgent,
        },
        tx,
      );

      await tx.session.update({
        where: { id: previous.id },
        data: { replacedById: created.id, revokedAt: new Date(), revokedReason: 'rotated' },
      });

      return created;
    });
  }

  async revoke(id: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Kills every session descended from the same login.
   *
   * Called when a rotated token is presented again: we cannot tell the victim
   * from the thief, so both are logged out and the user re-authenticates.
   */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /** Used after a password change: every other device must log in again. */
  async revokeAllForUser(userId: string, reason: string, exceptId?: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }
}
