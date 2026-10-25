import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthSession,
  MfaConfirmInput,
  MfaDisableInput,
  MfaRecoveryCodesView,
  MfaRegenerateInput,
  MfaSetupInput,
  MfaSetupView,
  MfaStatusView,
  MfaVerifyInput,
  mfaConfirmSchema,
  mfaDisableSchema,
  mfaRegenerateSchema,
  mfaSetupSchema,
  mfaVerifySchema,
} from '@qa-flow-hub/shared';
import { Public } from '../../../common/decorators/public.decorator';
import { zodBody } from '../../../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../../../database/tenant-context.service';
import { UnauthenticatedError } from '../../../errors';
import { AuthService } from '../auth.service';
import { CurrentUser, CurrentUserContext } from '../decorators/current-user.decorator';
import { SkipOrganization } from '../decorators/skip-organization.decorator';
import { RefreshCookieService } from '../refresh-cookie.service';
import { MfaService } from './mfa.service';

/**
 * Account-level, like the rest of `/auth`: a user enrols a factor once and it
 * applies in every organization they belong to. `@SkipOrganization()` also
 * keeps these routes reachable for a member whose organization requires MFA
 * they have not set up yet — otherwise they could never comply.
 */
@ApiTags('auth')
@SkipOrganization()
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly refreshCookie: RefreshCookieService,
    private readonly context: TenantContextService,
  ) {}

  @Public()
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Second login step: exchange a challenge and a code for a session' })
  async verify(
    @Body(zodBody(mfaVerifySchema)) body: MfaVerifyInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const session = await this.auth.verifyMfa(body);
    return this.refreshCookie.handOver(session, request, reply);
  }

  @ApiBearerAuth()
  @Get()
  @ApiOperation({ summary: 'Whether MFA is enabled and this session passed it' })
  status(@CurrentUser() user: CurrentUserContext): Promise<MfaStatusView> {
    return this.mfa.status(user.userId, this.context.mfaAuthenticated);
  }

  @ApiBearerAuth()
  @Post('setup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start TOTP enrolment; the secret is shown only in this response' })
  setup(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(mfaSetupSchema)) body: MfaSetupInput,
  ): Promise<MfaSetupView> {
    return this.mfa.setup(user.userId, body.password);
  }

  @ApiBearerAuth()
  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm enrolment with a first code; returns recovery codes once' })
  confirm(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(mfaConfirmSchema)) body: MfaConfirmInput,
  ): Promise<MfaRecoveryCodesView> {
    return this.mfa.confirm(user.userId, this.requireSessionId(), body.code);
  }

  @ApiBearerAuth()
  @Post('disable')
  @HttpCode(204)
  @ApiOperation({ summary: 'Turn MFA off (password and current code required)' })
  async disable(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(mfaDisableSchema)) body: MfaDisableInput,
  ): Promise<void> {
    await this.mfa.disable(user.userId, body.password, body.code);
  }

  @ApiBearerAuth()
  @Post('recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace all recovery codes; the new ones are shown once' })
  regenerate(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(mfaRegenerateSchema)) body: MfaRegenerateInput,
  ): Promise<MfaRecoveryCodesView> {
    return this.mfa.regenerateRecoveryCodes(user.userId, body.code);
  }

  private requireSessionId(): string {
    const sessionId = this.context.sessionId;
    if (sessionId === undefined) {
      throw new UnauthenticatedError();
    }
    return sessionId;
  }
}
