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
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import {
  DefectAssignedEvent,
  DefectStatusChangedEvent,
  InvitationIssuedEvent,
  PasswordChangedEvent,
  TestRunCasesAssignedEvent,
  TestRunCompletedEvent,
} from '../../events/domain-events';
import { EmailAdapter } from '../../integrations/adapter.contracts';
import { EMAIL_ADAPTER } from '../../integrations/adapter.tokens';
import { MockEmailAdapter } from '../../integrations/email-mock/email-mock.adapter';
import { AuditService } from '../audit/audit.service';
import { NotificationsRepository } from './notifications.repository';
import { fromPayload, toPayload } from './templates/template-payload';
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

/** Rejections a retry cannot fix: the address itself is undeliverable. */
const PERMANENT_FAILURES = new Set(['mailbox_unavailable']);

/** Template variables that are dates; JSON brings them back as strings. */

export interface OutboxDrainResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
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

  @OnEvent('test_run.completed', { promisify: true })
  onTestRunCompleted(event: TestRunCompletedEvent): Promise<void> {
    return this.tenant.runForOrganization(event.organizationId, () =>
      this.handleTestRunCompleted(event),
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

  private async handleTestRunCompleted(event: TestRunCompletedEvent): Promise<void> {
    const summary = await this.notifications.findRunFailureSummary(
      event.organizationId,
      event.testRunId,
    );
    if (summary === null || summary.failedCases === 0) return;
    const [actor, organization, project] = await Promise.all([
      this.notifications.findUser(event.actorUserId),
      this.notifications.findOrganizationName(event.organizationId),
      this.notifications.findProjectName(event.organizationId, event.projectId),
    ]);

    // Whoever opened the run and whoever owns a failed case. Not the project.
    const interested = new Set(
      [summary.createdById, ...summary.failedAssigneeIds].filter(
        (id): id is string => id !== null && id !== event.actorUserId,
      ),
    );
    for (const userId of interested) {
      const recipient = await this.notifications.findUser(userId);
      if (recipient === null) continue;
      await this.deliver({
        type: 'test_run_failed',
        organizationId: event.organizationId,
        recipient: asRecipient(recipient),
        dedupeKey: `test_run_failed:${event.testRunId}:${userId}`,
        vars: {
          recipientName: recipient.fullName,
          completedByName: actor?.fullName ?? 'A teammate',
          organizationName: organization?.name ?? '',
          projectName: project?.name ?? '',
          runName: summary.name,
          failedCases: summary.failedCases,
          blockedCases: summary.blockedCases,
          totalCases: summary.totalCases,
          runUrl: `${this.config.webBaseUrl}/test-runs/${event.testRunId}`,
        },
        metadata: {
          entityType: 'test_run',
          entityId: event.testRunId,
          projectId: event.projectId,
          failedCases: String(summary.failedCases),
          actorUserId: event.actorUserId,
        },
      });
    }
  }

  // --- Pipeline --------------------------------------------------------------

  /**
   * Records the fact first, then makes the first attempt in this request. The
   * row keeps its template variables until it is delivered or skipped, so a
   * failed attempt — or a crash between insert and send — is picked up by the
   * outbox worker instead of being lost.
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
      payload: toPayload(plan.type, plan.vars),
      leaseUntil: this.leaseDeadline(),
    });
    if (row === null) {
      this.logger.debug(`Duplicate suppressed: ${plan.dedupeKey}`);
      return;
    }
    await this.attempt(row, rendered);
  }

  /**
   * One delivery attempt for a row whose lease the caller holds. Skip rules
   * are evaluated now, not when the row was created: a recipient who lost the
   * project, left the organization or muted the category in the meantime does
   * not get the message on a retry.
   */
  private async attempt(row: Notification, rendered: RenderedEmail): Promise<Notification> {
    const skip = await this.decideSkip(row);
    if (skip !== null) {
      return this.notifications.markSkipped(row.id, skip);
    }

    try {
      const outcome = await this.email.send({
        to: row.recipientEmail,
        from: this.config.email.from,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        reference: row.id,
        tags: {
          type: row.type,
          ...(row.organizationId === null ? {} : { organizationId: row.organizationId }),
        },
      });
      if (outcome.accepted) {
        return await this.notifications.markSent(row.id, this.email.provider, outcome.messageId);
      }
      return await this.fail(row, outcome.reason ?? 'rejected');
    } catch (error: unknown) {
      return this.fail(row, error instanceof Error ? error.message : 'provider_error');
    }
  }

  private fail(row: Notification, reason: string): Promise<Notification> {
    const next = PERMANENT_FAILURES.has(reason) ? null : this.nextAttemptAt(row.attempts + 1);
    return this.notifications.markFailed(row.id, this.email.provider, reason, next);
  }

  /** Exponential backoff, capped; null once the attempt budget is spent. */
  private nextAttemptAt(attempts: number): Date | null {
    const { maxAttempts, retryBaseMs, retryMaxMs } = this.config.notifications;
    if (attempts >= maxAttempts) return null;
    const delay = Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs);
    return new Date(Date.now() + delay);
  }

  private leaseDeadline(): Date {
    return new Date(Date.now() + this.config.notifications.leaseSeconds * 1000);
  }

  private async decideSkip(row: Notification): Promise<NotificationSkipReason | null> {
    const category = NOTIFICATION_CATEGORY_BY_TYPE[row.type];
    const optional = (OPTIONAL_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
    // Security and onboarding mail is not opt-out: a user who disabled email
    // still has to learn their password changed, and an invitee has no
    // preferences yet.
    if (!optional || row.recipientUserId === null) return null;

    const user = await this.notifications.findUser(row.recipientUserId);
    if (user === null || !user.isActive) return 'recipient_inactive';

    // A message about a project is only for someone who can still see it;
    // otherwise the subject alone would reveal the project's name.
    const projectId = metadataOf(row)['projectId'];
    if (
      row.organizationId !== null &&
      projectId !== undefined &&
      !(await this.notifications.recipientCanSeeProject(
        row.organizationId,
        row.recipientUserId,
        projectId,
      ))
    ) {
      return 'recipient_no_access';
    }

    const preference = await this.notifications.findPreference(row.recipientUserId);
    if (preference === null) return null; // defaults: everything on
    if (!preference.emailEnabled) return 'email_disabled';
    if (!preference[PREFERENCE_FIELD[category as OptionalNotificationCategory]]) {
      return 'category_disabled';
    }
    return null;
  }

  // --- Outbox ----------------------------------------------------------------

  /**
   * One pass of the outbox worker: lease due rows across organizations, then
   * attempt each one inside its own tenant, so every read and write after the
   * lease goes through RLS exactly as a request would.
   */
  async drainOutbox(): Promise<OutboxDrainResult> {
    const { workerBatch, leaseSeconds } = this.config.notifications;
    const claimed = await this.tenant.runForOrganization(null, () =>
      this.notifications.claimDue(workerBatch, leaseSeconds),
    );
    const result: OutboxDrainResult = { claimed: claimed.length, sent: 0, failed: 0, skipped: 0 };
    for (const item of claimed) {
      try {
        const outcome = await this.tenant.runForOrganization(item.organizationId, async () => {
          const row = await this.notifications.findById(item.id);
          if (row === null || row.payload === null) return null;
          const rendered = renderStored(row);
          if (rendered === null) {
            return this.notifications.markFailed(
              row.id,
              this.email.provider,
              'payload_unreadable',
              null,
            );
          }
          return this.attempt(row, rendered);
        });
        if (outcome?.status === 'sent') result.sent += 1;
        else if (outcome?.status === 'failed') result.failed += 1;
        else if (outcome?.status === 'skipped') result.skipped += 1;
      } catch (error: unknown) {
        this.logger.error(
          `Outbox attempt failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  /**
   * Manual retry by an operator: one more attempt now, even past the budget.
   * Only for a failed row of the active organization that still holds its
   * content and that no worker is delivering at this moment.
   */
  async retry(caller: { role: string }, id: string): Promise<NotificationView> {
    if (!OPERATOR_ROLES.has(caller.role)) {
      throw new ForbiddenError('Only owners and admins can retry a notification');
    }
    const organizationId = this.tenant.get()?.organizationId ?? null;
    const row = await this.notifications.findById(id);
    if (row === null || organizationId === null || row.organizationId !== organizationId) {
      throw new NotFoundError('Notification');
    }
    const rendered = row.status === 'failed' ? renderStored(row) : null;
    if (rendered === null) {
      throw new ConflictError(
        'Only a failed notification that still has its content can be retried',
      );
    }
    if (!(await this.notifications.leaseFailed(row.id, this.leaseDeadline()))) {
      throw new ConflictError('This notification is already being delivered');
    }
    const updated = await this.attempt(row, rendered);
    await this.audit.record({
      action: AuditAction.update,
      entityType: 'notification',
      entityId: row.id,
      summary: `Retried delivery of a ${row.type} notification: ${updated.status}`,
      changes: { status: { from: row.status, to: updated.status } },
    });
    return toView(updated);
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

/**
 * Re-renders a stored row from its payload, or null when there is nothing
 * usable to render (already delivered, or not a payload of this template).
 */
function renderStored(row: Notification): RenderedEmail | null {
  const vars = fromPayload(row.type, row.payload);
  return vars === null ? null : renderEmail(row.type, vars);
}

function metadataOf(row: Notification): Record<string, string> {
  return isStringRecord(row.metadata) ? row.metadata : {};
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
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
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
