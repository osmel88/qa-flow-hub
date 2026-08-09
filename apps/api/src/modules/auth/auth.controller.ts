import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthSession,
  AuthTokens,
  ChangePasswordInput,
  LoginInput,
  RefreshInput,
  RegisterInput,
  UpdateProfileInput,
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  updateProfileSchema,
} from '@qa-flow-hub/shared';
import { Public } from '../../common/decorators/public.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { UnauthenticatedError } from '../../errors';
import { AuthService } from './auth.service';
import { RefreshCookieService } from './refresh-cookie.service';
import { CurrentUser, CurrentUserContext } from './decorators/current-user.decorator';
import { SkipOrganization } from './decorators/skip-organization.decorator';

/**
 * Authentication lives above the tenant boundary: you cannot pick an
 * organization before you have logged in. Hence `@SkipOrganization()` on the
 * whole controller.
 */
@ApiTags('auth')
@SkipOrganization()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly refreshCookie: RefreshCookieService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and start a session' })
  async register(
    @Body(zodBody(registerSchema)) body: RegisterInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const session = await this.auth.register(body);
    return this.refreshCookie.handOver(session, request, reply);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for a token pair' })
  async login(
    @Body(zodBody(loginSchema)) body: LoginInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const session = await this.auth.login(body);
    return this.refreshCookie.handOver(session, request, reply);
  }

  /**
   * Public because the access token is, by definition, expired when a client
   * calls this. The refresh token is the credential, and for a browser it
   * arrives as a cookie it never had to read.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  async refresh(
    @Body(zodBody(refreshSchema)) body: RefreshInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokens> {
    const tokens = await this.auth.refresh(this.presentedToken(body, request));
    return this.refreshCookie.handOver(tokens, request, reply);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(
    @Body(zodBody(refreshSchema)) body: RefreshInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    // The cookie goes first: if revocation fails, the browser must still end up
    // without a credential it can present again.
    this.refreshCookie.clear(reply);
    await this.auth.logout(this.presentedToken(body, request));
  }

  /**
   * A refresh token from the cookie or, for clients without a cookie jar, from
   * the body. Absence is an authentication failure, not a validation error: the
   * caller simply has no credential.
   */
  private presentedToken(body: RefreshInput, request: FastifyRequest): string {
    const token = this.refreshCookie.read(request) ?? body.refreshToken;
    if (token === undefined) {
      throw new UnauthenticatedError('No refresh token was presented');
    }
    return token;
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke every session of the current user' })
  async logoutAll(
    @CurrentUser() user: CurrentUserContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    this.refreshCookie.clear(reply);
    await this.auth.logoutEverywhere(user.userId);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The current user and the organizations they belong to' })
  me(@CurrentUser() user: CurrentUserContext) {
    return this.auth.getProfile(user.userId);
  }

  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({ summary: 'Update the current profile' })
  updateProfile(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(updateProfileSchema)) body: UpdateProfileInput,
  ) {
    return this.auth.updateProfile(user.userId, body);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change the password and log every device out' })
  async changePassword(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(changePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    await this.auth.changePassword(user.userId, body);
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'Active sessions, so the user can see and revoke them' })
  async sessions(@CurrentUser() user: CurrentUserContext) {
    const sessions = await this.auth.listSessions(user.userId);
    // The token hash never leaves the server, not even to its owner.
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    }));
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one session' })
  async revokeSession(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
  ): Promise<void> {
    await this.auth.revokeSession(user.userId, id);
  }
}
