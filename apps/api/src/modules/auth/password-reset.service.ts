import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ForgotPasswordView,
  PASSWORD_RESET_INVALID_MESSAGE,
  PASSWORD_RESET_MAX_REQUESTS,
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_WINDOW_MINUTES,
  ResetPasswordInput,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ValidationError } from '../../errors';
import { DomainEventsPublisher } from '../../events/domain-events';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { UsersRepository } from './users.repository';

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Password recovery: "forgot" issues a single-use link by email, "reset"
 * spends it. Both answer the same way whatever the address, so neither tells
 * a caller which accounts exist. Only a SHA-256 of the token is stored.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly config: AppConfigService,
    private readonly context: TenantContextService,
    private readonly events: DomainEventsPublisher,
    private readonly audit: AuditService,
  ) {}

  /** The link is revealed in the response only outside production with the mock mailer. */
  private get exposesMockLink(): boolean {
    return !this.config.isProduction && this.config.email.provider === 'mock';
  }

  async request(email: string): Promise<ForgotPasswordView> {
    const resetUrl = await this.issue(email);
    return this.exposesMockLink ? { accepted: true, mockResetUrl: resetUrl } : { accepted: true };
  }

  private async issue(email: string): Promise<string | null> {
    const user = await this.users.findByEmail(email);
    if (user === null || !user.isActive || user.deletedAt !== null) {
      return null;
    }
    const now = new Date();
    const windowStart = new Date(now.getTime() - PASSWORD_RESET_WINDOW_MINUTES * 60_000);
    const recent = await this.prisma.passwordResetToken.count({
      where: { userId: user.id, createdAt: { gte: windowStart } },
    });
    if (recent >= PASSWORD_RESET_MAX_REQUESTS) {
      this.logger.warn(`Password reset throttled: user=${user.id}`);
      return null;
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);
    const row = await this.prisma.$transaction(async (tx) => {
      // Only the newest link is alive: asking again kills the previous one.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      return tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt,
          requestedIp: this.context.get()?.ipAddress ?? null,
        },
      });
    });
    const resetUrl = `${this.config.webBaseUrl}/reset-password?token=${token}`;
    await this.audit.record({
      action: 'password_reset',
      entityType: 'user',
      entityId: user.id,
      summary: 'Password reset link requested',
      organizationId: null,
      userId: user.id,
    });
    await this.events.publish('user.password_reset.requested', {
      userId: user.id,
      tokenId: row.id,
      resetUrl,
      expiresAt,
    });
    return resetUrl;
  }

  /**
   * Spends the token and sets the password in one transaction. The guarded
   * `updateMany` is the single-use check: of two concurrent requests with the
   * same token, the second re-reads the row after the first commits and
   * matches nothing.
   */
  async reset(input: ResetPasswordInput): Promise<void> {
    const now = new Date();
    const passwordHash = await this.passwords.hash(input.newPassword);
    const result = await this.prisma.$transaction(async (tx) => {
      const token = await tx.passwordResetToken.findUnique({
        where: { tokenHash: hashResetToken(input.token) },
        include: { user: true },
      });
      if (token === null || !token.user.isActive || token.user.deletedAt !== null) {
        return null;
      }
      const spent = await tx.passwordResetToken.updateMany({
        where: { id: token.id, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (spent.count !== 1) {
        return null;
      }
      await tx.user.update({
        where: { id: token.userId },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: token.userId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      // Whoever had the old password may hold a session too.
      const revoked = await tx.session.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'password_reset' },
      });
      return { userId: token.userId, revoked: revoked.count };
    });
    if (result === null) {
      throw new ValidationError(PASSWORD_RESET_INVALID_MESSAGE);
    }
    this.logger.log(`Password reset: user=${result.userId} sessionsRevoked=${result.revoked}`);
    await this.audit.record({
      action: 'password_reset',
      entityType: 'user',
      entityId: result.userId,
      summary: 'Password reset with a recovery link; every session was revoked',
      changes: { sessionsRevoked: result.revoked },
      organizationId: null,
      userId: result.userId,
    });
    await this.events.publish('user.password.changed', { userId: result.userId, changedAt: now });
  }
}
