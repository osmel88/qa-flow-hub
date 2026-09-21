import { Injectable } from '@nestjs/common';
import {
  Notification,
  NotificationPreference,
  NotificationStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { ListNotificationsQuery, toSkipTake } from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';

export interface NotificationDraft {
  organizationId: string | null;
  recipientUserId: string | null;
  recipientEmail: string;
  type: NotificationType;
  templateKey: string;
  subject: string;
  dedupeKey: string;
  metadata: Record<string, string>;
}

/**
 * The delivery ledger and the per-user preferences.
 *
 * Not a `TenantAwareRepository` on purpose: the ledger holds account-level
 * rows with no organization (password changed), which `scope()` could never
 * write. Tenant safety is kept by hand and is narrow: every organization
 * read filters on `organizationId` *and* runs on the RLS client, so a row of
 * another tenant is filtered twice. Preferences carry no organization at all.
 */
@Injectable()
export class NotificationsRepository {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  private get prisma() {
    return this.prismaService.scoped;
  }

  /**
   * Inserts the pending row, or returns `null` when the same fact was already
   * recorded. The unique index on `dedupeKey` is the arbiter, so two requests
   * racing to announce the same assignment cannot both win.
   */
  async createPending(draft: NotificationDraft): Promise<Notification | null> {
    try {
      return await this.prisma.notification.create({
        data: {
          organizationId: draft.organizationId,
          recipientUserId: draft.recipientUserId,
          recipientEmail: draft.recipientEmail,
          type: draft.type,
          templateKey: draft.templateKey,
          subject: draft.subject,
          dedupeKey: draft.dedupeKey,
          metadata: draft.metadata,
          status: NotificationStatus.pending,
        },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  markSent(id: string, provider: string, providerMessageId: string | null): Promise<Notification> {
    const now = new Date();
    return this.prisma.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.sent,
        provider,
        providerMessageId,
        attempts: { increment: 1 },
        attemptedAt: now,
        deliveredAt: now,
        failureReason: null,
      },
    });
  }

  markFailed(id: string, provider: string, failureReason: string): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.failed,
        provider,
        attempts: { increment: 1 },
        attemptedAt: new Date(),
        failureReason,
      },
    });
  }

  markSkipped(id: string, skipReason: string): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: { status: NotificationStatus.skipped, skipReason },
    });
  }

  /** What was addressed to one user inside the active organization. */
  async listForRecipient(
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<{ items: Notification[]; total: number }> {
    return this.list(
      {
        organizationId: this.tenant.requireOrganizationId(),
        recipientUserId: userId,
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      query,
    );
  }

  /** Every message of the active organization, for its operators. */
  async listForOrganization(
    query: ListNotificationsQuery,
  ): Promise<{ items: Notification[]; total: number }> {
    return this.list(
      {
        organizationId: this.tenant.requireOrganizationId(),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      query,
    );
  }

  private async list(
    where: Prisma.NotificationWhereInput & { organizationId: string },
    query: ListNotificationsQuery,
  ): Promise<{ items: Notification[]; total: number }> {
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(query),
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { items, total };
  }

  // --- Context reads --------------------------------------------------------
  // The pipeline resolves names and addresses itself instead of importing five
  // business modules: a listener that depends on the module that emits to it
  // is a cycle waiting to happen. Reads only, and every tenant-owned one is
  // filtered by organization on top of RLS.

  findUser(
    id: string,
  ): Promise<{ id: string; email: string; fullName: string; isActive: boolean } | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, email: true, fullName: true, isActive: true },
    });
  }

  findUserByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
  }

  findOrganizationName(id: string): Promise<{ name: string } | null> {
    return this.prisma.organization.findFirst({ where: { id }, select: { name: true } });
  }

  findProjectName(organizationId: string, id: string): Promise<{ name: string } | null> {
    return this.prisma.project.findFirst({ where: { id, organizationId }, select: { name: true } });
  }

  findTestRunName(organizationId: string, id: string): Promise<{ name: string } | null> {
    return this.prisma.testRun.findFirst({ where: { id, organizationId }, select: { name: true } });
  }

  findDefect(
    organizationId: string,
    id: string,
  ): Promise<{
    key: string;
    title: string;
    severity: string;
    assigneeId: string | null;
    reportedById: string | null;
  } | null> {
    return this.prisma.defect.findFirst({
      where: { id, organizationId },
      select: { key: true, title: true, severity: true, assigneeId: true, reportedById: true },
    });
  }

  findPreference(userId: string): Promise<NotificationPreference | null> {
    return this.prisma.notificationPreference.findUnique({ where: { userId } });
  }

  upsertPreference(
    userId: string,
    data: Prisma.NotificationPreferenceUpdateInput,
  ): Promise<NotificationPreference> {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...toCreate(data) },
      update: data,
    });
  }
}

function toCreate(
  data: Prisma.NotificationPreferenceUpdateInput,
): Omit<Prisma.NotificationPreferenceUncheckedCreateInput, 'userId'> {
  return {
    ...(typeof data.emailEnabled === 'boolean' ? { emailEnabled: data.emailEnabled } : {}),
    ...(typeof data.testRunAssignments === 'boolean'
      ? { testRunAssignments: data.testRunAssignments }
      : {}),
    ...(typeof data.defectAssignments === 'boolean'
      ? { defectAssignments: data.defectAssignments }
      : {}),
    ...(typeof data.statusChanges === 'boolean' ? { statusChanges: data.statusChanges } : {}),
  };
}
