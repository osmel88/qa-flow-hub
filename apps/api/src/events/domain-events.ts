import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DefectStatus, OrganizationRole } from '@prisma/client';

/**
 * Domain events: facts a business module announces after it has committed
 * them, without knowing who listens. Today the only listener is
 * `NotificationsService`; tomorrow a webhook or an in-app inbox subscribes to
 * the same names and the emitting module does not change.
 *
 * Payloads carry ids and the few values a listener would otherwise re-read.
 * They never carry secrets: the invitation event has the acceptance URL
 * because the email needs it, and the notification pipeline is the only place
 * that reads it — nothing persists or logs the payload.
 */

export interface InvitationIssuedEvent {
  organizationId: string;
  invitationId: string;
  email: string;
  role: OrganizationRole;
  invitedByUserId: string;
  acceptUrl: string;
  expiresAt: Date;
  /** 0 on first issue, then the resend count; each value produces its own mail. */
  resendCount: number;
}

export interface PasswordChangedEvent {
  userId: string;
  changedAt: Date;
}

export interface TestRunCasesAssignedEvent {
  organizationId: string;
  projectId: string;
  testRunId: string;
  assigneeUserId: string;
  actorUserId: string;
  /** The run cases this operation assigned; the same set again is not news. */
  runCaseIds: readonly string[];
}

export interface DefectAssignedEvent {
  organizationId: string;
  projectId: string;
  defectId: string;
  assigneeUserId: string;
  actorUserId: string;
  changedAt: Date;
}

export interface DefectStatusChangedEvent {
  organizationId: string;
  projectId: string;
  defectId: string;
  fromStatus: DefectStatus;
  toStatus: DefectStatus;
  actorUserId: string;
  changedAt: Date;
}

export interface DomainEventMap {
  'organization.invitation.issued': InvitationIssuedEvent;
  'user.password.changed': PasswordChangedEvent;
  'test_run.cases.assigned': TestRunCasesAssignedEvent;
  'defect.assigned': DefectAssignedEvent;
  'defect.status.changed': DefectStatusChangedEvent;
}

export type DomainEventName = keyof DomainEventMap;

/**
 * Typed façade over the in-process emitter.
 *
 * `publish` awaits the listeners. That is a deliberate S2-F6 trade: the
 * request that assigned a defect returns only after the notification row is
 * written and the mock provider answered, so a test can assert on the ledger
 * right after the response and nothing is lost when the process exits. The
 * cost is latency equal to the slowest listener, which with the mock is zero
 * and with a real provider would argue for a persisted queue (see
 * docs/technical-debt.md). Listener errors are logged by the emitter module
 * (`suppressErrors`) and never fail the request: the business write already
 * happened, and failing the caller for a mail would be lying about it.
 */
@Injectable()
export class DomainEventsPublisher {
  private readonly logger = new Logger(DomainEventsPublisher.name);

  constructor(private readonly emitter: EventEmitter2) {}

  async publish<N extends DomainEventName>(name: N, payload: DomainEventMap[N]): Promise<void> {
    try {
      await this.emitter.emitAsync(name, payload);
    } catch (error: unknown) {
      this.logger.error(
        `Listener failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
