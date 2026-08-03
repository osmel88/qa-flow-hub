import { Module } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { OrganizationInvitationsRepository } from './organization-invitations.repository';
import { OrganizationMembersRepository } from './organization-members.repository';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';

/**
 * This module deliberately does not import AuthModule, even though the two are
 * closely related: AuthModule imports *this* one, because registration can
 * accept an invitation. Keeping the dependency one-directional avoids a
 * circular module reference and, more usefully, states which module owns what —
 * membership and invitations live here, credentials and sessions live there.
 */
@Module({
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    InvitationsService,
    OrganizationsRepository,
    OrganizationMembersRepository,
    OrganizationInvitationsRepository,
  ],
  exports: [
    OrganizationsService,
    InvitationsService,
    OrganizationsRepository,
    OrganizationMembersRepository,
  ],
})
export class OrganizationsModule {}
