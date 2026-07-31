import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { AuthService } from './auth.service';
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
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and start a session' })
  register(@Body(zodBody(registerSchema)) body: RegisterInput): Promise<AuthSession> {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for a token pair' })
  login(@Body(zodBody(loginSchema)) body: LoginInput): Promise<AuthSession> {
    return this.auth.login(body);
  }

  /**
   * Public because the access token is, by definition, expired when a client
   * calls this. The refresh token is the credential.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  refresh(@Body(zodBody(refreshSchema)) body: RefreshInput): Promise<AuthTokens> {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body(zodBody(refreshSchema)) body: RefreshInput): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke every session of the current user' })
  async logoutAll(@CurrentUser() user: CurrentUserContext): Promise<void> {
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
