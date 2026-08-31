import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  InvitationStatus,
  MembershipStatus,
  OrganizationInvitation,
  OrganizationRole,
} from '@prisma/client';
import {
  CreateInvitationInput,
  CreatedInvitationView,
  InvitationView,
  ROLE_RANK,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  ForbiddenError,
  NotFoundError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { OrganizationInvitationsRepository } from './organization-invitations.repository';
import {
  hashInvitationToken,
  issueInvitationToken,
} from './organization-invitations.repository';
import { OrganizationMembersRepository } from './organization-members.repository';

export interface InvitationPreview {
  organizationName: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
}

export interface AcceptedInvitation {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

/**
 * The invitation lifecycle: invite → (resend | revoke) → accept.
 *
 * Two properties drive every decision here. First, the invited person may not
 * have an account yet, so an invitation cannot be a membership row with a
 * pending flag — it is its own entity keyed by email. Second, the token *is*
 * the authorization to join, so it is treated like a password: 256 bits of
 * entropy, stored only as a hash, single use, time limited, and replaceable.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly invitations: OrganizationInvitationsRepository,
    private readonly members: OrganizationMembersRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * `invitedBy` carries the inviter's role, not just their id: without the rank
   * check an admin could invite an owner and end up outranked by someone they
   * created. `changeMemberRole` refuses the same move, so allowing it here would
   * make the invitation form the way around the rule.
   */
  async invite(
    organizationId: string,
    invitedBy: { userId: string; role: OrganizationRole },
    input: CreateInvitationInput,
  ): Promise<CreatedInvitationView> {
    if (ROLE_RANK[input.role] < ROLE_RANK[invitedBy.role]) {
      throw new ForbiddenError('You cannot invite somebody with a role more powerful than your own');
    }

    // Lapsed invitations are settled first, otherwise the partial unique index
    // on (organizationId, email) WHERE status = 'pending' would keep rejecting
    // a legitimate re-invite for a week after the first one went stale.
    await this.invitations.expireOverdue();

    const existingMember = await this.prisma.organizationMember.findFirst({
      where: { organizationId, deletedAt: null, user: { email: input.email } },
    });
    if (existingMember !== null) {
      throw new ConflictError('That person is already a member of this organization');
    }

    if ((await this.invitations.findPending(organizationId, input.email)) !== null) {
      throw new DuplicateResourceError('pending invitation', 'email');
    }

    const issued = issueInvitationToken();
    const invitation = await this.invitations.create({
      organizationId,
      email: input.email,
      role: input.role,
      tokenHash: issued.tokenHash,
      expiresAt: this.expiryFromNow(),
      invitedById: invitedBy.userId,
    });

    await this.audit.record({
      action: AuditAction.invite,
      entityType: 'OrganizationInvitation',
      entityId: invitation.id,
      summary: `Invited ${input.email} as ${input.role}`,
      changes: { email: input.email, role: input.role },
    });

    return this.toCreatedView(invitation, issued.token);
  }

  async list(organizationId: string): Promise<InvitationView[]> {
    await this.invitations.expireOverdue();
    const rows = await this.invitations.listForOrganization(organizationId);
    return rows.map((row) => this.toView(row));
  }

  /**
   * Conceptual resend: no email is sent yet, but the operation that matters
   * already exists — a fresh token, a fresh expiry, and the previous token dead.
   * When an email provider is wired in, it subscribes here and nothing else
   * changes. See docs/integrations-roadmap.md.
   */
  async resend(organizationId: string, id: string): Promise<CreatedInvitationView> {
    const invitation = await this.invitations.findById(organizationId, id);
    if (invitation === null) {
      throw new NotFoundError('Invitation');
    }
    if (invitation.status !== InvitationStatus.pending) {
      throw new ConflictError(`Only a pending invitation can be resent (this one is ${invitation.status})`);
    }

    const issued = issueInvitationToken();
    const updated = await this.invitations.refreshToken(id, issued.tokenHash, this.expiryFromNow());
    if (updated === null) {
      throw new ConflictError('The invitation is no longer pending');
    }

    await this.audit.record({
      action: AuditAction.invite,
      entityType: 'OrganizationInvitation',
      entityId: id,
      summary: `Resent the invitation for ${invitation.email} (attempt ${updated.resendCount + 1})`,
    });

    return this.toCreatedView(updated, issued.token);
  }

  async revoke(organizationId: string, id: string): Promise<void> {
    const invitation = await this.invitations.findById(organizationId, id);
    if (invitation === null) {
      throw new NotFoundError('Invitation');
    }
    if (!(await this.invitations.revoke(organizationId, id))) {
      throw new ConflictError(`Only a pending invitation can be revoked (this one is ${invitation.status})`);
    }

    await this.audit.record({
      action: AuditAction.revoke_invite,
      entityType: 'OrganizationInvitation',
      entityId: id,
      summary: `Revoked the invitation for ${invitation.email}`,
    });
  }

  /**
   * What the acceptance screen shows before the user commits: which
   * organization, as what, until when. The token is the secret, so revealing
   * these three facts to whoever holds it reveals nothing new.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findAcceptable(token);
    const organization = await this.prisma.organization.findUnique({
      where: { id: invitation.organizationId },
      select: { name: true },
    });

    return {
      organizationName: organization?.name ?? 'Unknown organization',
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Accepts an invitation on behalf of an authenticated user.
   *
   * Called from two places — `POST /organizations/invitations/accept` for a user
   * who already has an account, and registration for one who does not — which
   * is why it takes the identity as arguments instead of reading a request.
   */
  async accept(token: string, userId: string, userEmail: string): Promise<AcceptedInvitation> {
    const invitation = await this.findAcceptable(token);

    // The invitation is bound to the address it was sent to. Without this, a
    // forwarded link would let anybody join under somebody else's invitation —
    // and an admin who invited a colleague would have onboarded a stranger.
    if (invitation.email !== userEmail.trim().toLowerCase()) {
      throw new ConflictError('This invitation was issued for a different email address');
    }

    const organization = await this.prisma.organization.findFirst({
      where: { id: invitation.organizationId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (organization === null) {
      throw new NotFoundError('Organization');
    }

    // One transaction: consuming the invitation and granting the membership are
    // the same fact. Half of it would either grant access no invitation
    // accounts for, or burn an invitation without granting anything.
    await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.invitations.markAccepted(invitation.id, userId, tx))) {
        throw new ConflictError('The invitation is no longer pending');
      }

      // Read through `tx`: a read on the pooled client would run on another
      // connection and could not see the write above.
      const existing = await this.members.findAnyMembership(userId, organization.id, tx);
      if (existing === null) {
        await this.members.create(
          {
            organizationId: organization.id,
            userId,
            role: invitation.role,
            status: MembershipStatus.active,
          },
          tx,
        );
      } else {
        await this.members.reactivate(organization.id, userId, invitation.role, tx);
      }

      await this.audit.record(
        {
          action: AuditAction.accept_invite,
          entityType: 'OrganizationInvitation',
          entityId: invitation.id,
          summary: `${userEmail} joined as ${invitation.role}`,
          organizationId: organization.id,
        },
        tx,
      );
    });

    this.logger.log(`Invitation accepted: org=${organization.id} user=${userId}`);
    return { organizationId: organization.id, organizationName: organization.name, role: invitation.role };
  }

  /**
   * Resolves a token to an invitation that can still be accepted.
   *
   * Expiry is checked against the row's own `expiresAt` rather than trusting
   * the `expired` status to have been swept: a background transition that has
   * not run yet must never widen the window.
   */
  private async findAcceptable(token: string): Promise<OrganizationInvitation> {
    const invitation = await this.invitations.findByTokenHash(hashInvitationToken(token));

    // A wrong token and a revoked one are the same answer, for the same reason
    // a wrong password and an unknown account are.
    if (invitation === null || invitation.status !== InvitationStatus.pending) {
      throw new NotFoundError('Invitation');
    }
    if (invitation.expiresAt <= new Date()) {
      throw new ConflictError('This invitation has expired. Ask for a new one.');
    }
    return invitation;
  }

  private expiryFromNow(): Date {
    return new Date(Date.now() + this.config.invitationTtlDays * 24 * 60 * 60 * 1000);
  }

  private toView(invitation: OrganizationInvitation): InvitationView {
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role as InvitationView['role'],
      status: invitation.status,
      expiresAt: invitation.expiresAt.toISOString(),
      resendCount: invitation.resendCount,
      lastSentAt: invitation.lastSentAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }

  private toCreatedView(
    invitation: OrganizationInvitation,
    token: string,
  ): CreatedInvitationView {
    return {
      ...this.toView(invitation),
      token,
      acceptUrl: `${this.config.webBaseUrl}/invitations/accept?token=${token}`,
    };
  }
}
