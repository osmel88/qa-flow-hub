import { Injectable, Logger } from '@nestjs/common';
import { Session, User } from '@prisma/client';
import {
  AuthSession,
  AuthTokens,
  AuthenticatedUser,
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContextService } from '../../database/tenant-context.service';
import {
  DuplicateResourceError,
  InvalidCredentialsError,
  RateLimitedError,
  TokenReuseDetectedError,
  UnauthenticatedError,
} from '../../errors';
import { InvitationsService } from '../organizations/invitations.service';
import { PasswordService } from './password.service';
import { SessionsRepository } from './sessions.repository';
import { TokenService } from './token.service';
import { UsersRepository } from './users.repository';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
    private readonly context: TenantContextService,
    private readonly invitations: InvitationsService,
  ) {}

  async register(input: RegisterInput): Promise<AuthSession> {
    const existing = await this.users.findByEmail(input.email);
    if (existing !== null) {
      // Registration is the one place where existence cannot be hidden: the
      // address either can or cannot be registered. The mitigation is rate
      // limiting on the endpoint, not a vague message that breaks the form.
      throw new DuplicateResourceError('account', 'email');
    }

    const user = await this.users.create({
      email: input.email,
      fullName: input.fullName,
      passwordHash: await this.passwords.hash(input.password),
    });

    // Accepting the invitation happens after the account exists, and its
    // failure is *not* swallowed: a user who signed up through an invitation
    // link and silently ended up in no organization would see an empty product
    // and no explanation. The account is kept, so retrying acceptance is one
    // login away.
    if (input.invitationToken !== undefined) {
      await this.invitations.accept(input.invitationToken, user.id, user.email);
    }

    return this.startSession(user);
  }

  async login(input: LoginInput): Promise<AuthSession> {
    const user = await this.users.findByEmail(input.email);

    if (user === null) {
      // Spend the same time as a real verification so the response time does
      // not reveal whether the address exists.
      await this.passwords.wasteTime();
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil !== null && user.lockedUntil > new Date()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new RateLimitedError(
        'Too many failed attempts. Try again later.',
        retryAfter,
      );
    }

    if (!user.isActive) {
      throw new InvalidCredentialsError();
    }

    const valid = await this.passwords.verify(user.passwordHash, input.password);
    if (!valid) {
      const { maxFailedAttempts, lockoutMinutes } = this.config.authLockout;
      const { locked } = await this.users.registerFailedLogin(
        user.id,
        maxFailedAttempts,
        lockoutMinutes,
      );
      if (locked) {
        this.logger.warn(`Account locked after repeated failures: user=${user.id}`);
      }
      throw new InvalidCredentialsError();
    }

    // Transparent upgrade if the cost parameters were raised since this hash
    // was written. The user never notices and never has to reset.
    const rehashed = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(input.password)
      : undefined;
    await this.users.registerSuccessfulLogin(user.id, rehashed);

    return this.startSession(user);
  }

  /**
   * Rotating refresh: every refresh invalidates the token it was given and
   * issues a new one in the same family.
   *
   * Rotation is what turns a stolen refresh token from permanent access into a
   * detectable event. Whoever uses the token second presents one that is
   * already rotated, and that is the signal to kill the whole family.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const session = await this.sessions.findByTokenHash(
      this.tokens.hashRefreshToken(refreshToken),
    );

    if (session === null) {
      throw new UnauthenticatedError('The refresh token is not valid');
    }

    if (session.revokedAt !== null) {
      // Already used or explicitly revoked. Either the legitimate user is
      // replaying an old token or somebody stole one; we cannot tell, so both
      // are logged out.
      const revoked = await this.sessions.revokeFamily(session.familyId, 'reuse_detected');
      this.logger.warn(
        `Refresh token reuse detected: user=${session.userId} family=${session.familyId} revoked=${revoked}`,
      );
      throw new TokenReuseDetectedError();
    }

    if (session.expiresAt <= new Date()) {
      await this.sessions.revoke(session.id, 'expired');
      throw new UnauthenticatedError('The session has expired');
    }

    const user = await this.users.findById(session.userId);
    if (user === null || !user.isActive) {
      await this.sessions.revokeFamily(session.familyId, 'user_inactive');
      throw new UnauthenticatedError('The account is no longer active');
    }

    const issued = this.tokens.issueRefreshToken();

    // One transaction: a crash between the two writes would either revoke the
    // old session without a successor (logging the user out) or leave two live
    // tokens (defeating rotation).
    const next = await this.sessions.rotate(session, issued.tokenHash, {
      expiresAt: new Date(Date.now() + this.tokens.refreshTokenTtlSeconds * 1000),
      ipAddress: this.context.get()?.ipAddress,
      userAgent: this.context.get()?.userAgent,
    });

    return {
      accessToken: this.tokens.signAccessToken({ sub: user.id, sid: next.id, email: user.email }),
      refreshToken: issued.token,
      expiresIn: this.tokens.accessTokenTtlSeconds,
    };
  }

  /** Logout is a database write, which is the whole point of opaque tokens. */
  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(
      this.tokens.hashRefreshToken(refreshToken),
    );
    if (session !== null && session.revokedAt === null) {
      await this.sessions.revoke(session.id, 'logout');
    }
    // An unknown or already-revoked token still reports success: logout must
    // be idempotent, and it must not double as a token oracle.
  }

  async logoutEverywhere(userId: string): Promise<number> {
    return this.sessions.revokeAllForUser(userId, 'logout_all');
  }

  async changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new UnauthenticatedError();
    }

    const valid = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!valid) {
      throw new InvalidCredentialsError();
    }

    await this.users.update(userId, { passwordHash: await this.passwords.hash(input.newPassword) });

    // Changing a password means "I think somebody may have it". Leaving other
    // sessions alive would make the change cosmetic.
    const revoked = await this.sessions.revokeAllForUser(userId, 'password_changed');
    this.logger.log(`Password changed: user=${userId} sessionsRevoked=${revoked}`);
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<AuthenticatedUser> {
    const user = await this.users.update(userId, {
      ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
    });
    return toPublicUser(user);
  }

  async getProfile(userId: string): Promise<AuthSession['user'] & { organizations: AuthSession['organizations'] }> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new UnauthenticatedError();
    }
    return { ...toPublicUser(user), organizations: await this.users.listOrganizations(user.id) };
  }

  listSessions(userId: string): Promise<Session[]> {
    return this.sessions.listActiveForUser(userId);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    // Silently succeed for somebody else's session id rather than confirming
    // that it exists.
    if (session !== null && session.userId === userId) {
      await this.sessions.revoke(session.id, 'revoked_by_user');
    }
  }

  private async startSession(user: User): Promise<AuthSession> {
    const issued = this.tokens.issueRefreshToken();
    const context = this.context.get();

    const session = await this.sessions.create({
      userId: user.id,
      refreshTokenHash: issued.tokenHash,
      expiresAt: new Date(Date.now() + this.tokens.refreshTokenTtlSeconds * 1000),
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    return {
      accessToken: this.tokens.signAccessToken({
        sub: user.id,
        sid: session.id,
        email: user.email,
      }),
      refreshToken: issued.token,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      user: toPublicUser(user),
      organizations: await this.users.listOrganizations(user.id),
    };
  }
}

/** The only shape of a user that ever leaves the API. Never the password hash. */
export function toPublicUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
  };
}
