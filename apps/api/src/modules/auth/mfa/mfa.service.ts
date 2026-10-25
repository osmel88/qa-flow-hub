import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  MFA_RECOVERY_CODE_COUNT,
  MfaChallengeView,
  MfaRecoveryCodesView,
  MfaSetupView,
  MfaStatusView,
  MfaVerifyInput,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../../config/app-config.service';
import { PrismaService, PrismaTransaction } from '../../../database/prisma.service';
import {
  ConflictError,
  InvalidCredentialsError,
  MfaInvalidCodeError,
  UnauthenticatedError,
} from '../../../errors';
import { AuditService } from '../../audit/audit.service';
import { PasswordService } from '../password.service';
import { UsersRepository } from '../users.repository';
import {
  MfaSecretBox,
  generateRecoveryCode,
  generateTotpSecret,
  matchTotp,
  mfaHash,
  otpauthUri,
} from './totp';

type VerifyOutcome =
  | { ok: true; userId: string }
  | { ok: false; userId: string | null; reason: string };

/**
 * TOTP second factor (RFC 6238) with single-use recovery codes.
 *
 * Every acceptance is a conditional write, so two requests racing with the same
 * code, recovery code or challenge produce exactly one winner: the TOTP step
 * only moves forward (`lastUsedStep < step`), a recovery code only goes from
 * unused to used, and a challenge is consumed once under a row lock.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly box: MfaSecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {
    this.box = new MfaSecretBox(this.config.mfa.encryptionKey);
  }

  async isEnabled(userId: string): Promise<boolean> {
    const factor = await this.prisma.mfaTotpFactor.findUnique({ where: { userId } });
    return factor?.confirmedAt != null;
  }

  async status(userId: string, sessionVerified: boolean): Promise<MfaStatusView> {
    const factor = await this.prisma.mfaTotpFactor.findUnique({ where: { userId } });
    const enabled = factor?.confirmedAt != null;
    const recoveryCodesRemaining = enabled
      ? await this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } })
      : 0;
    return {
      enabled,
      confirmedAt: factor?.confirmedAt?.toISOString() ?? null,
      recoveryCodesRemaining,
      sessionVerified,
    };
  }

  /**
   * Starts (or restarts) enrolment. The new secret replaces any unconfirmed
   * one; a confirmed factor must be disabled first, so a stolen session cannot
   * silently swap the victim's authenticator for the attacker's.
   */
  async setup(userId: string, password: string): Promise<MfaSetupView> {
    const user = await this.requirePassword(userId, password);
    const secret = generateTotpSecret();
    const sealed = this.box.seal(secret, userId);

    const written = await this.prisma.runInTransaction(async (tx) => {
      await this.lockUser(tx, userId);
      const existing = await tx.mfaTotpFactor.findUnique({ where: { userId } });
      if (existing?.confirmedAt != null) return false;
      await tx.mfaTotpFactor.upsert({
        where: { userId },
        create: { userId, secretCiphertext: sealed },
        update: { secretCiphertext: sealed, lastUsedStep: null },
      });
      return true;
    });
    if (!written) {
      throw new ConflictError('Multi-factor authentication is already enabled');
    }

    return { secret, otpauthUri: otpauthUri(this.config.mfa.issuer, user.email, secret) };
  }

  /**
   * Confirms enrolment with a first valid code. The current session becomes
   * MFA-verified and every other session is revoked: they were opened with the
   * password alone, which is exactly the assurance level this raises.
   */
  async confirm(userId: string, sessionId: string, code: string): Promise<MfaRecoveryCodesView> {
    const recoveryCodes = Array.from({ length: MFA_RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const confirmed = await this.prisma.runInTransaction(async (tx) => {
      await this.lockUser(tx, userId);
      const factor = await tx.mfaTotpFactor.findUnique({ where: { userId } });
      if (factor === null || factor.confirmedAt !== null) return 'not_pending' as const;
      const step = matchTotp(this.openSecret(factor.secretCiphertext, userId), code, Date.now(), null);
      if (step === null) return 'invalid' as const;

      await tx.mfaTotpFactor.update({
        where: { userId },
        data: { confirmedAt: new Date(), lastUsedStep: step },
      });
      await this.replaceRecoveryCodes(tx, userId, recoveryCodes);
      await tx.session.update({ where: { id: sessionId }, data: { mfaAuthenticated: true } });
      await tx.session.updateMany({
        where: { userId, revokedAt: null, id: { not: sessionId } },
        data: { revokedAt: new Date(), revokedReason: 'mfa_enabled' },
      });
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'MfaFactor',
          entityId: factor.id,
          summary: 'Enabled multi-factor authentication',
          organizationId: null,
        },
        tx,
      );
      return 'confirmed' as const;
    });

    if (confirmed === 'not_pending') {
      throw new ConflictError('Start multi-factor setup before confirming it');
    }
    if (confirmed === 'invalid') {
      throw new MfaInvalidCodeError();
    }
    return { recoveryCodes };
  }

  /**
   * Turning MFA off needs the password *and* a current code, and downgrades
   * every session of the user, so organizations that require MFA stop
   * accepting them on the next request.
   */
  async disable(userId: string, password: string, code: string): Promise<void> {
    await this.requirePassword(userId, password);
    const outcome = await this.prisma.runInTransaction(async (tx) => {
      await this.lockUser(tx, userId);
      const factor = await tx.mfaTotpFactor.findUnique({ where: { userId } });
      if (factor?.confirmedAt == null) return 'not_enabled' as const;
      if (!(await this.consumeTotp(tx, userId, factor.secretCiphertext, code))) {
        return 'invalid' as const;
      }
      await tx.mfaTotpFactor.delete({ where: { userId } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaChallenge.deleteMany({ where: { userId } });
      await tx.session.updateMany({ where: { userId }, data: { mfaAuthenticated: false } });
      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'MfaFactor',
          entityId: factor.id,
          summary: 'Disabled multi-factor authentication',
          organizationId: null,
        },
        tx,
      );
      return 'disabled' as const;
    });
    if (outcome === 'not_enabled') {
      throw new ConflictError('Multi-factor authentication is not enabled');
    }
    if (outcome === 'invalid') {
      throw new MfaInvalidCodeError();
    }
  }

  async regenerateRecoveryCodes(userId: string, code: string): Promise<MfaRecoveryCodesView> {
    const recoveryCodes = Array.from({ length: MFA_RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const outcome = await this.prisma.runInTransaction(async (tx) => {
      await this.lockUser(tx, userId);
      const factor = await tx.mfaTotpFactor.findUnique({ where: { userId } });
      if (factor?.confirmedAt == null) return 'not_enabled' as const;
      if (!(await this.consumeTotp(tx, userId, factor.secretCiphertext, code))) {
        return 'invalid' as const;
      }
      await this.replaceRecoveryCodes(tx, userId, recoveryCodes);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'MfaFactor',
          entityId: factor.id,
          summary: 'Regenerated MFA recovery codes',
          organizationId: null,
        },
        tx,
      );
      return 'ok' as const;
    });
    if (outcome === 'not_enabled') {
      throw new ConflictError('Multi-factor authentication is not enabled');
    }
    if (outcome === 'invalid') {
      throw new MfaInvalidCodeError();
    }
    return { recoveryCodes };
  }

  /** Issued by login once the password is right and a factor is enabled. */
  async createChallenge(userId: string): Promise<MfaChallengeView> {
    const token = randomBytes(32).toString('base64url');
    const { challengeTtlSeconds } = this.config.mfa;
    await this.prisma.mfaChallenge.create({
      data: {
        userId,
        tokenHash: this.hash('challenge', token),
        expiresAt: new Date(Date.now() + challengeTtlSeconds * 1000),
      },
    });
    // Expired challenges are useless; deleting them here keeps the table small
    // without a sweeper.
    await this.prisma.mfaChallenge.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    });
    return { mfaRequired: true, challengeToken: token, expiresIn: challengeTtlSeconds };
  }

  /**
   * Second login step. Returns the user id once the challenge is consumed.
   *
   * The challenge row is locked for the whole check, so concurrent attempts on
   * one challenge are serialized. Failures are *returned* from the transaction
   * rather than thrown inside it, so the attempt counter they increment is
   * committed, and each failure also counts towards the account lockout.
   */
  async verifyChallenge(input: MfaVerifyInput): Promise<string> {
    const tokenHash = this.hash('challenge', input.challengeToken);
    const { challengeMaxAttempts } = this.config.mfa;

    const outcome = await this.prisma.runInTransaction(async (tx): Promise<VerifyOutcome> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "mfa_challenges" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
      const challengeId = locked[0]?.id;
      if (challengeId === undefined) return { ok: false, userId: null, reason: 'unknown' };
      const challenge = await tx.mfaChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      if (
        challenge.consumedAt !== null ||
        challenge.expiresAt <= new Date() ||
        challenge.attempts >= challengeMaxAttempts
      ) {
        return { ok: false, userId: null, reason: 'unusable' };
      }

      const factor = await tx.mfaTotpFactor.findUnique({ where: { userId: challenge.userId } });
      let accepted = false;
      if (factor?.confirmedAt != null) {
        accepted =
          input.code !== undefined
            ? await this.consumeTotp(tx, challenge.userId, factor.secretCiphertext, input.code)
            : await this.consumeRecoveryCode(tx, challenge.userId, input.recoveryCode ?? '');
      }

      if (!accepted) {
        await tx.mfaChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        return { ok: false, userId: challenge.userId, reason: 'invalid_code' };
      }

      await tx.mfaChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      await this.audit.record(
        {
          action: AuditAction.login,
          entityType: 'MfaFactor',
          entityId: factor?.id ?? challenge.userId,
          summary:
            input.code !== undefined
              ? 'Signed in with an authenticator code'
              : 'Signed in with a recovery code',
          organizationId: null,
          userId: challenge.userId,
        },
        tx,
      );
      return { ok: true, userId: challenge.userId };
    });

    if (outcome.ok) {
      return outcome.userId;
    }
    if (outcome.userId !== null) {
      const { maxFailedAttempts, lockoutMinutes } = this.config.authLockout;
      await this.users.registerFailedLogin(outcome.userId, maxFailedAttempts, lockoutMinutes);
      this.logger.warn(`MFA verification failed: user=${outcome.userId} reason=${outcome.reason}`);
      throw new MfaInvalidCodeError();
    }
    // An unknown or spent challenge is not a wrong code: the client restarts at the password.
    throw new UnauthenticatedError('The sign-in challenge is no longer valid; sign in again');
  }

  private async requirePassword(userId: string, password: string): Promise<{ email: string }> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new UnauthenticatedError();
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new InvalidCredentialsError();
    }
    return user;
  }

  /** Serializes MFA writes per user: enrolment, disable and regeneration. */
  private async lockUser(tx: PrismaTransaction, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
  }

  private async consumeTotp(
    tx: PrismaTransaction,
    userId: string,
    sealed: string,
    code: string,
  ): Promise<boolean> {
    const current = await tx.mfaTotpFactor.findUnique({ where: { userId } });
    const step = matchTotp(
      this.openSecret(sealed, userId),
      code,
      Date.now(),
      current?.lastUsedStep ?? null,
    );
    if (step === null) return false;
    const moved = await tx.mfaTotpFactor.updateMany({
      where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    return moved.count === 1;
  }

  private async consumeRecoveryCode(
    tx: PrismaTransaction,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const used = await tx.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: this.hash('recovery', code), usedAt: null },
      data: { usedAt: new Date() },
    });
    return used.count === 1;
  }

  private async replaceRecoveryCodes(
    tx: PrismaTransaction,
    userId: string,
    codes: readonly string[],
  ): Promise<void> {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: this.hash('recovery', code) })),
    });
  }

  private openSecret(sealed: string, userId: string): string {
    return this.box.open(sealed, userId);
  }

  private hash(purpose: string, value: string): string {
    return mfaHash(this.config.mfa.encryptionKey, purpose, value);
  }
}
