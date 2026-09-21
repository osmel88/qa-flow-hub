import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditAction, Notification, NotificationPreference } from '@prisma/client';
import {
  EmailProviderView,
  ListNotificationsQuery,
  MockEmailPreview,
  NOTIFICATION_CATEGORY_BY_TYPE,
  NotificationPreferencesView,
  NotificationSkipReason,
  NotificationType,
  NotificationView,
  OPTIONAL_NOTIFICATION_CATEGORIES,
  OptionalNotificationCategory,
  Paginated,
  UpdateNotificationPreferencesInput,
  buildPaginationMeta,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ForbiddenError } from '../../errors';
import {
  DefectAssignedEvent,
  DefectStatusChangedEvent,
  InvitationIssuedEvent,
  PasswordChangedEvent,
  TestRunCasesAssignedEvent,
} from '../../events/domain-events';
import { EmailAdapter } from '../../integrations/adapter.contracts';
import { EMAIL_ADAPTER } from '../../integrations/adapter.tokens';
import { MockEmailAdapter } from '../../integrations/email-mock/email-mock.adapter';
import { AuditService } from '../audit/audit.service';
import { NotificationsRepository } from './notifications.repository';
import {
  EmailTemplateVars,
  RenderedEmail,
  TEMPLATE_KEYS,
  renderEmail,
} from './templates/email-templates';

const OPERATOR_ROLES = new Set(['organization_owner', 'organization_admin']);

/** Defect transitions worth an email; the rest are noise to the people involved. */
const NOTIFIED_DEFECT_STATUSES = new Set(['resolved', 'closed', 'rejected', 'reopened']);

/** Who a message is for, once the id has been turned into an address. */
interface Recipient {
  userId: string | null;
  email: string;
  fullName: string;
}

/**
 * Everything the pipeline needs about one message before it touches the
 * provider. Built by the listener for its event; from here on nothing is
 * event-specific.
 */
interface Plan<T extends NotificationType> {
  type: T;
  organizationId: string | null;
  recipient: Recipient;
  /** Identity of the fact being announced; the ledger's unique key. */
  dedupeKey: string;
  vars: EmailTemplateVars[T];
  /** Ids and labels only. No bodies, no links, no tokens. */
  metadata: Record<string, string>;
}

const PREFERENCE_FIELD: Record<OptionalNotificationCategory, keyof NotificationPreference> = {
  test_run_assignments: 'testRunAssignments',
  defect_assignments: 'defectAssignments',
  status_changes: 'statusChanges',
};

/**
 * Domain event → recipient → preference → ledger row → provider → status.
 *
 * Listeners are thin: they resolve names and decide who should hear about the
 * fact, then hand a `Plan` to `deliver()`, which is the only place that knows
 * about preferences, deduplication and the provider. Business modules know
 * neither; they publish an event and return.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly tenant: TenantContextService,
    @Inject(EMAIL_ADAPTER) private readonly email: EmailAdapter,
    private readonly mockEmail: MockEmailAdapter,
  ) {}

  // --- Listeners -------------------------------------------------------------

  @OnEvent('organization.invitation.issued', { promisify: true })
  onInvitationIssued(event: InvitationIssuedEvent): Promise<void> {
    return this.tenant.runForOrganization(event.organizationId, () =>
      this.handleInvitationIssued(event),
    );
  }

  @OnEvent('user.password.changed', { promisify: true })
  onPasswordChanged(event: PasswordChangedEvent): Promise<void> {
    return this.tenant.runForOrganization(null, () => this.handlePasswordChanged(event));
  }

  @OnEvent('test_run.cases.assigned', { promisify: true })
  onTestRunCasesAssigned(event: TestRunCasesAssignedEvent): Promise<void> {
    return this.tenant.runForOrganization(event.organizationId, () =>
      this.handleTestRunCasesAssigned(event),
    );
  }

  @OnEvent('defect.assigned', { promisify: true })
  onDefectAssigned(event: DefectAssignedEvent): Promise<void> {
    return this.tenant.runForOrganization(event.organizationId, () =>
      this.handleDefectAssigned(event),
    );
  }

  @OnEvent('defect.status.changed', { promisify: true })
  onDefectStatusChanged(event: DefectStatusChangedEvent): Promise<void> {
    return this.tenant.runForOrganization(event.organizationId, () =>
      this.handleDefectStatusChanged(event),
    );
  }

  // Each handler runs inside the tenant the event belongs to (or none), so the
  // RLS client scopes the ledger writes to the right organization regardless
  // of which header the triggering request carried.

  private async handleInvitationIssued(event: InvitationIssuedEvent): Promise<void> {
    const [organization, inviter, existing] = await Promise.all([
      this.notifications.findOrganizationName(event.organizationId),
      this.notifications.findUser(event.invitedByUserId),
      this.notifications.findUserByEmail(event.email),
    ]);
    await this.deliver({
      type: 'organization_invitation',
      organizationId: event.organizationId,
      // The invitee may not have an account yet; the address is the recipient.
      recipient: { userId: existing?.id ?? null, email: event.email, fullName: '' },
      dedupeKey: `organization_invitation:${event.invitationId}:${event.resendCount}`,
      vars: {
        organizationName: organization?.name ?? 'your organization',
        inviterName: inviter?.fullName ?? 'A teammate',
        role: event.role,
        acceptUrl: event.acceptUrl,
        expiresAt: event.expiresAt,
      },
      metadata: {
        entityType: 'organization_invitation',
        entityId: event.invitationId,
        role: event.role,
        resendCount: String(event.resendCount),
        actorUserId: event.invitedByUserId,
      },
    });
  }

  private async handlePasswordChanged(event: PasswordChangedEvent): Promise<void> {
    const user = await this.notifications.findUser(event.userId);
    if (user === null) return;
    await this.deliver({
      type: 'password_changed',
      organizationId: null,
      recipient: asRecipient(user),
      dedupeKey: `password_changed:${user.id}:${event.changedAt.getTime()}`,
      vars: {
        fullName: user.fullName,
        changedAt: event.changedAt,
        loginUrl: `${this.config.webBaseUrl}/login`,
      },
      metadata: { entityType: 'user', entityId: user.id },
    });
  }

  private async handleTestRunCasesAssigned(event: TestRunCasesAssignedEvent): Promise<void> {
    if (event.assigneeUserId === event.actorUserId) return;
    const [assignee, actor, organization, project, run] = await Promise.all([
      this.notifications.findUser(event.assigneeUserId),
      this.notifications.findUser(event.actorUserId),
      this.notifications.findOrganizationName(event.organizationId),
      this.notifications.findProjectName(event.organizationId, event.projectId),
      this.notifications.findTestRunName(event.organizationId, event.testRunId),
    ]);
    if (assignee === null || run === null) return;
    const caseSet = fingerprint(event.runCaseIds);
    await this.deliver({
      type: 'test_run_assignment',
      organizationId: event.organizationId,
      recipient: asRecipient(assignee),
      dedupeKey: `test_run_assignment:${event.testRunId}:${assignee.id}:${caseSet}`,
      vars: {
        assigneeName: assignee.fullName,
        assignedByName: actor?.fullName ?? 'A teammate',
        organizationName: organization?.name ?? '',
        projectName: project?.name ?? '',
        runName: run.name,
        assignedCases: event.runCaseIds.length,
        runUrl: `${this.config.webBaseUrl}/test-runs/${event.testRunId}`,
      },
      metadata: {
        entityType: 'test_run',
        entityId: event.testRunId,
        projectId: event.projectId,
        assignedCases: String(event.runCaseIds.length),
        actorUserId: event.actorUserId,
      },
    });
  }

  private async handleDefectAssigned(event: DefectAssignedEvent): Promise<void> {
    if (event.assigneeUserId === event.actorUserId) return;
    const [assignee, actor, organization, project, defect] = await Promise.all([
      this.notifications.findUser(event.assigneeUserId),
      this.notifications.findUser(event.actorUserId),
      this.notifications.findOrganizationName(event.organizationId),
      this.notifications.findProjectName(event.organizationId, event.projectId),
      this.notifications.findDefect(event.organizationId, event.defectId),
    ]);
    if (assignee === null || defect === null) return;
    await this.deliver({
      type: 'defect_assignment',
      organizationId: event.organizationId,
      recipient: asRecipient(assignee),
      dedupeKey: `defect_assignment:${event.defectId}:${assignee.id}:${event.changedAt.getTime()}`,
      vars: {
        assigneeName: assignee.fullName,
        assignedByName: actor?.fullName ?? 'A teammate',
        organizationName: organization?.name ?? '',
        projectName: project?.name ?? '',
        defectTitle: `${defect.key} — ${defect.title}`,
        severity: defect.severity,
        defectUrl: `${this.config.webBaseUrl}/defects`,
      },
      metadata: {
        entityType: 'defect',
        entityId: event.defectId,
        defectKey: defect.key,
        projectId: event.projectId,
        actorUserId: event.actorUserId,
      },
    });
  }

  private async handleDefectStatusChanged(event: DefectStatusChangedEvent): Promise<void> {
    if (!NOTIFIED_DEFECT_STATUSES.has(event.toStatus)) return;
    const [actor, organization, project, defect] = await Promise.all([
      this.notifications.findUser(event.actorUserId),
      this.notifications.findOrganizationName(event.organizationId),
      this.notifications.findProjectName(event.organizationId, event.projectId),
      this.notifications.findDefect(event.organizationId, event.defectId),
    ]);
    if (defect === null) return;

    // The people with a stake in this defect: whoever it is assigned to and
    // whoever reported it. Not the whole project — that is the spam the
    // preferences exist to avoid, and no preference would save it.
    const interested = new Set(
      [defect.assigneeId, defect.reportedById].filter(
        (id): id is string => id !== null && id !== event.actorUserId,
      ),
    );
    for (const userId of interested) {
      const recipient = await this.notifications.findUser(userId);
      if (recipient === null) continue;
      await this.deliver({
        type: 'defect_status_changed',
        organizationId: event.organizationId,
        recipient: asRecipient(recipient),
        dedupeKey: `defect_status_changed:${event.defectId}:${event.toStatus}:${event.changedAt.getTime()}:${userId}`,
        vars: {
          recipientName: recipient.fullName,
          changedByName: actor?.fullName ?? 'A teammate',
          organizationName: organization?.name ?? '',
          projectName: project?.name ?? '',
          defectTitle: `${defect.key} — ${defect.title}`,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          defectUrl: `${this.config.webBaseUrl}/defects`,
        },
        metadata: {
          entityType: 'defect',
          entityId: event.defectId,
          defectKey: defect.key,
          projectId: event.projectId,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          actorUserId: event.actorUserId,
        },
      });
    }
  }

  // --- Pipeline --------------------------------------------------------------

  /**
   * Records the fact first, then tries to deliver it. Order matters: a row
   * that says `pending` and never moves is a visible failure; a mail that was
   * sent with no row is an invisible one.
   *
   * Skips are recorded too. "Why did I not get that email?" is a support
   * question, and the answer should be in the ledger, not in a log line.
   */
  private async deliver<T extends NotificationType>(plan: Plan<T>): Promise<void> {
    const rendered: RenderedEmail = renderEmail(plan.type, plan.vars);
    const row = await this.notifications.createPending({
      organizationId: plan.organizationId,
      recipientUserId: plan.recipient.userId,
      recipientEmail: plan.recipient.email,
      type: plan.type,
      templateKey: TEMPLATE_KEYS[plan.type],
      subject: rendered.subject,
      dedupeKey: plan.dedupeKey,
      metadata: plan.metadata,
    });
    if (row === null) {
      this.logger.debug(`Duplicate suppressed: ${plan.dedupeKey}`);
      return;
    }

    const skip = await this.decideSkip(plan);
    if (skip !== null) {
      await this.notifications.markSkipped(row.id, skip);
      return;
    }

    try {
      const outcome = await this.email.send({
        to: plan.recipient.email,
        from: this.config.email.from,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        reference: row.id,
        tags: {
          type: plan.type,
          ...(plan.organizationId === null ? {} : { organizationId: plan.organizationId }),
        },
      });
      if (outcome.accepted) {
        await this.notifications.markSent(row.id, this.email.provider, outcome.messageId);
      } else {
        await this.notifications.markFailed(
          row.id,
          this.email.provider,
          outcome.reason ?? 'rejected',
        );
      }
    } catch (error: unknown) {
      await this.notifications.markFailed(
        row.id,
        this.email.provider,
        error instanceof Error ? error.message : 'provider_error',
      );
    }
  }

  private async decideSkip<T extends NotificationType>(
    plan: Plan<T>,
  ): Promise<NotificationSkipReason | null> {
    const category = NOTIFICATION_CATEGORY_BY_TYPE[plan.type];
    const optional = (OPTIONAL_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
    // Security and onboarding mail is not opt-out: a user who disabled email
    // still has to learn their password changed, and an invitee has no
    // preferences yet.
    if (!optional || plan.recipient.userId === null) return null;

    const user = await this.notifications.findUser(plan.recipient.userId);
    if (user === null || !user.isActive) return 'recipient_inactive';

    const preference = await this.notifications.findPreference(plan.recipient.userId);
    if (preference === null) return null; // defaults: everything on
    if (!preference.emailEnabled) return 'email_disabled';
    if (!preference[PREFERENCE_FIELD[category as OptionalNotificationCategory]]) {
      return 'category_disabled';
    }
    return null;
  }

  // --- Reads and preferences -------------------------------------------------

  async list(
    caller: { userId: string; role: string },
    query: ListNotificationsQuery,
  ): Promise<Paginated<NotificationView>> {
    if (query.scope === 'organization' && !OPERATOR_ROLES.has(caller.role)) {
      throw new ForbiddenError('Only owners and admins can list every notification');
    }
    const { items, total } =
      query.scope === 'organization'
        ? await this.notifications.listForOrganization(query)
        : await this.notifications.listForRecipient(caller.userId, query);
    return { data: items.map(toView), meta: buildPaginationMeta(query, total) };
  }

  /**
   * The development outbox: what the mock provider captured for messages of
   * the active organization. Goes through the ledger and not the provider's
   * memory directly, so the tenant filter is the database's, and links are
   * redacted because an invitation link is the invitation.
   */
  async outbox(
    caller: { role: string },
    query: ListNotificationsQuery,
  ): Promise<Paginated<MockEmailPreview>> {
    if (!OPERATOR_ROLES.has(caller.role)) {
      throw new ForbiddenError('Only owners and admins can inspect the outbox');
    }
    const { items, total } = await this.notifications.listForOrganization({
      ...query,
      status: 'sent',
    });
    const captured = this.mockEmail.findMany(items.map((item) => item.id));
    return {
      data: captured.map((message) => ({
        notificationId: message.reference,
        to: message.to,
        subject: message.subject,
        text: redactLinks(message.text),
        html: message.html === null ? null : redactLinks(message.html),
        capturedAt: message.capturedAt.toISOString(),
      })),
      meta: buildPaginationMeta(query, total),
    };
  }

  provider(): EmailProviderView {
    return {
      provider: this.email.provider,
      mode: this.email.provider === 'mock' ? 'mock' : 'real',
      inspectable: this.email.provider === 'mock',
      fromAddress: this.config.email.from,
    };
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesView> {
    return toPreferencesView(await this.notifications.findPreference(userId));
  }

  async updatePreferences(
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferencesView> {
    const before = toPreferencesView(await this.notifications.findPreference(userId));
    const updated = await this.notifications.upsertPreference(userId, {
      ...(input.emailEnabled === undefined ? {} : { emailEnabled: input.emailEnabled }),
      ...(input.testRunAssignments === undefined
        ? {}
        : { testRunAssignments: input.testRunAssignments }),
      ...(input.defectAssignments === undefined
        ? {}
        : { defectAssignments: input.defectAssignments }),
      ...(input.statusChanges === undefined ? {} : { statusChanges: input.statusChanges }),
    });
    const after = toPreferencesView(updated);
    await this.audit.record({
      action: AuditAction.update,
      entityType: 'notification_preference',
      entityId: userId,
      summary: 'Updated notification preferences',
      changes: diff(before, after),
      organizationId: this.tenant.get()?.organizationId ?? null,
    });
    return after;
  }
}

function asRecipient(user: { id: string; email: string; fullName: string }): Recipient {
  return { userId: user.id, email: user.email, fullName: user.fullName };
}

function fingerprint(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join(','))
    .digest('hex')
    .slice(0, 16);
}

/** Replaces every URL query string; the path stays so the reader knows where it pointed. */
function redactLinks(body: string): string {
  return body.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g, '$1?[redacted]');
}

function toView(row: Notification): NotificationView {
  const type = row.type;
  return {
    id: row.id,
    type,
    category: NOTIFICATION_CATEGORY_BY_TYPE[type],
    channel: 'email',
    recipientEmail: row.recipientEmail,
    recipientUserId: row.recipientUserId,
    subject: row.subject,
    status: row.status,
    provider: row.provider,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    attemptedAt: row.attemptedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    failureReason: row.failureReason,
    skipReason: row.skipReason,
    metadata: isStringRecord(row.metadata) ? row.metadata : {},
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function toPreferencesView(row: NotificationPreference | null): NotificationPreferencesView {
  return row === null
    ? {
        emailEnabled: true,
        testRunAssignments: true,
        defectAssignments: true,
        statusChanges: true,
        updatedAt: null,
      }
    : {
        emailEnabled: row.emailEnabled,
        testRunAssignments: row.testRunAssignments,
        defectAssignments: row.defectAssignments,
        statusChanges: row.statusChanges,
        updatedAt: row.updatedAt.toISOString(),
      };
}

function diff(
  before: NotificationPreferencesView,
  after: NotificationPreferencesView,
): Record<string, { from: boolean; to: boolean }> {
  const keys = [
    'emailEnabled',
    'testRunAssignments',
    'defectAssignments',
    'statusChanges',
  ] as const;
  const changes: Record<string, { from: boolean; to: boolean }> = {};
  for (const key of keys) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}
