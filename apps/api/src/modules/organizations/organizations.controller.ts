import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AcceptInvitationInput,
  CreateInvitationInput,
  CreateOrganizationInput,
  ListMembersQuery,
  UpdateMemberInput,
  UpdateOrganizationInput,
  acceptInvitationSchema,
  createInvitationSchema,
  createOrganizationSchema,
  listMembersQuerySchema,
  updateMemberSchema,
  updateOrganizationSchema,
} from '@qa-flow-hub/shared';
import { Public } from '../../common/decorators/public.decorator';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { SkipOrganization } from '../auth/decorators/skip-organization.decorator';
import { InvitationsService } from './invitations.service';
import { OrganizationsService } from './organizations.service';

/**
 * Two groups of routes live here, and the difference is which side of the
 * tenant boundary they sit on.
 *
 * `@SkipOrganization()` routes work *without* an active organization, because
 * they are how a user gets one: creating an organization, listing the ones they
 * belong to, accepting an invitation. Everything else requires
 * `X-Organization-Id` and a membership in it.
 */
@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly invitations: InvitationsService,
  ) {}

  @SkipOrganization()
  @Post()
  @ApiOperation({ summary: 'Create an organization and become its owner' })
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(createOrganizationSchema)) body: CreateOrganizationInput,
  ) {
    return this.organizations.create(user.userId, body);
  }

  @SkipOrganization()
  @Get()
  @ApiOperation({ summary: 'Organizations the current user belongs to, with their role in each' })
  listMine(@CurrentUser() user: CurrentUserContext) {
    return this.organizations.listMine(user.userId);
  }

  /**
   * Previewing an invitation is public: the caller has no account yet in the
   * common case. The token is the credential, and the response only says what
   * the holder of the token already needs to know.
   */
  @Public()
  @SkipOrganization()
  @Get('invitations/preview')
  @ApiOperation({ summary: 'Which organization and role an invitation token grants' })
  preview(@Query('token') token: string) {
    return this.invitations.preview(token ?? '');
  }

  @SkipOrganization()
  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Join an organization using an invitation token' })
  accept(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(acceptInvitationSchema)) body: AcceptInvitationInput,
  ) {
    return this.invitations.accept(body.token, user.userId, user.email);
  }

  // --- Routes below require an active organization -------------------------

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Get('current')
  @ApiOperation({ summary: 'The active organization' })
  current(@CurrentUser() user: CurrentUserContext) {
    return this.organizations.get(user.organizationId);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner')
  @Patch('current')
  @ApiOperation({ summary: 'Rename the organization or change its plan' })
  update(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(updateOrganizationSchema)) body: UpdateOrganizationInput,
  ) {
    return this.organizations.update(user.organizationId, body);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Get('current/members')
  @ApiOperation({ summary: 'Members of the active organization' })
  listMembers(
    @CurrentUser() user: CurrentUserContext,
    @Query(zodQuery(listMembersQuerySchema)) query: ListMembersQuery,
  ) {
    return this.organizations.listMembers(user.organizationId, query);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner', 'organization_admin')
  @Patch('current/members/:userId')
  @ApiOperation({ summary: "Change a member's role" })
  changeMemberRole(
    @CurrentUser() user: CurrentUserContext,
    @Param('userId') targetUserId: string,
    @Body(zodBody(updateMemberSchema)) body: UpdateMemberInput,
  ) {
    return this.organizations.changeMemberRole(
      user.organizationId,
      { userId: user.userId, role: user.role },
      targetUserId,
      body.role,
    );
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner', 'organization_admin')
  @Delete('current/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a member from the organization' })
  async removeMember(
    @CurrentUser() user: CurrentUserContext,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    await this.organizations.removeMember(
      user.organizationId,
      { userId: user.userId, role: user.role },
      targetUserId,
    );
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner', 'organization_admin')
  @Post('current/invitations')
  @ApiOperation({ summary: 'Invite somebody by email, whether or not they have an account' })
  invite(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(createInvitationSchema)) body: CreateInvitationInput,
  ) {
    return this.invitations.invite(
      user.organizationId,
      { userId: user.userId, role: user.role },
      body,
    );
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner', 'organization_admin')
  @Get('current/invitations')
  @ApiOperation({ summary: 'Invitations of the active organization' })
  listInvitations(@CurrentUser() user: CurrentUserContext) {
    return this.invitations.list(user.organizationId);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner', 'organization_admin')
  @Post('current/invitations/:id/resend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a fresh token for a pending invitation' })
  resend(@CurrentUser() user: CurrentUserContext, @Param('id') id: string) {
    return this.invitations.resend(user.organizationId, id);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Roles('organization_owner', 'organization_admin')
  @Delete('current/invitations/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(
    @CurrentUser() user: CurrentUserContext,
    @Param('id') id: string,
  ): Promise<void> {
    await this.invitations.revoke(user.organizationId, id);
  }
}
