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
  /** Template variables a retry re-renders from. */
  payload: Prisma.InputJsonValue;
  /** The request that inserts the row owns the first attempt until then. */
  leaseUntil: Date;
}

/** A row the outbox worker leased, before it is read under its own tenant. */
export interface ClaimedNotification {
  id: string;
  organizationId: string | null;
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
          payload: draft.payload,
          leaseUntil: draft.leaseUntil,
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
        payload: Prisma.DbNull,
        leaseUntil: null,
        nextAttemptAt: null,
      },
    });
  }

  /** `nextAttemptAt` null means the retry budget is spent. */
  markFailed(
    id: string,
    provider: string,
    failureReason: string,
    nextAttemptAt: Date | null,
  ): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.failed,
        provider,
        attempts: { increment: 1 },
        attemptedAt: new Date(),
        failureReason,
        leaseUntil: null,
        nextAttemptAt,
      },
    });
  }

  markSkipped(id: string, skipReason: string): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.skipped,
        skipReason,
        payload: Prisma.DbNull,
        leaseUntil: null,
        nextAttemptAt: null,
      },
    });
  }

  // --- Outbox ---------------------------------------------------------------

  /**
   * Leases due rows across every organization through the one SECURITY
   * DEFINER function that may see them all; only ids and organizations come
   * back. `SKIP LOCKED` plus the lease give each row to exactly one worker.
   */
  claimDue(batch: number, leaseSeconds: number): Promise<ClaimedNotification[]> {
    return this.prismaService.scoped.$queryRaw<ClaimedNotification[]>`
      SELECT id, "organizationId" FROM claim_notification_deliveries(${batch}::int, ${leaseSeconds}::int)`;
  }

  findById(id: string): Promise<Notification | null> {
    return this.prisma.notification.findFirst({ where: { id } });
  }

  /**
   * Takes the lease of a failed row for a manual retry. Returns false when
   * the row is not failed or a worker holds it, so a retry never races a
   * delivery already in flight.
   */
  async leaseFailed(id: string, leaseUntil: Date): Promise<boolean> {
    const { count } = await this.prisma.notification.updateMany({
      where: {
        id,
        status: NotificationStatus.failed,
        payload: { not: Prisma.DbNull },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseUntil },
    });
    return count === 1;
  }

  /**
   * Whether the recipient can still see the project the message talks about:
   * an active member of the organization who is owner/admin or holds a grant,
   * and a project that still exists. Checked at send time, not at enqueue.
   */
  async recipientCanSeeProject(
    organizationId: string,
    userId: string,
    projectId: string,
  ): Promise<boolean> {
    const [member, project] = await Promise.all([
      this.prisma.organizationMember.findFirst({
        where: { organizationId, userId, status: 'active', deletedAt: null },
        select: { role: true },
      }),
      this.prisma.project.findFirst({
        where: { id: projectId, organizationId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (member === null || project === null) return false;
    if (member.role === 'organization_owner' || member.role === 'organization_admin') return true;
    const grant = await this.prisma.projectMember.findFirst({
      where: { organizationId, projectId, userId },
      select: { id: true },
    });
    return grant !== null;
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

  /** Totals of a completed run and who owns its failed cases. */
  async findRunFailureSummary(
    organizationId: string,
    testRunId: string,
  ): Promise<{
    name: string;
    createdById: string | null;
    totalCases: number;
    failedCases: number;
    blockedCases: number;
    failedAssigneeIds: string[];
  } | null> {
    const run = await this.prisma.testRun.findFirst({
      where: { id: testRunId, organizationId, deletedAt: null },
      select: { name: true, createdById: true },
    });
    if (run === null) return null;
    const cases = await this.prisma.testRunCase.findMany({
      where: { organizationId, testRunId },
      select: { latestStatus: true, assignedToId: true },
    });
    const failed = cases.filter((item) => item.latestStatus === 'failed');
    return {
      name: run.name,
      createdById: run.createdById,
      totalCases: cases.length,
      failedCases: failed.length,
      blockedCases: cases.filter((item) => item.latestStatus === 'blocked').length,
      failedAssigneeIds: [
        ...new Set(
          failed.map((item) => item.assignedToId).filter((id): id is string => id !== null),
        ),
      ],
    };
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
