import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, BillingProviderKind, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { BillingRepository } from './billing.repository';
import { BILLING_PROVIDER, BillingEvent, BillingProvider } from './billing-provider';
import { UsageLimitsService } from './usage-limits.service';

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

const date = (value: string | null): Date | null => (value === null ? null : new Date(value));

/**
 * The only path by which provider state reaches our tables.
 *
 * Order of operations, each one a reason a request can stop:
 * 1. the provider in the URL must be the configured one;
 * 2. the signature over the raw bytes and its timestamp must verify;
 * 3. the customer id must map to an organization — through our own mapping,
 *    never a tenant id the payload claims;
 * 4. the event id must be new: the insert on (provider, event id) is the
 *    idempotency key, and it happens in the same transaction as the effects,
 *    so a crash in between leaves neither.
 */
@Injectable()
export class BillingWebhooksService {
  private readonly logger = new Logger(BillingWebhooksService.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly billing: BillingRepository,
    private readonly limits: UsageLimitsService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async handle(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookOutcome> {
    if (providerName !== this.provider.name) {
      throw new NotFoundError('Billing provider');
    }
    if (rawBody === undefined || rawBody.length === 0) {
      throw new ValidationError('The webhook body is empty');
    }

    const event = this.provider.parseWebhook(rawBody, headers, new Date());
    const kind = BillingProviderKind[this.provider.name];
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    const organizationId = await this.tenant.runForOrganization(
      null,
      async () => await this.billing.organizationForCustomer(kind, event.externalCustomerId),
    );

    if (organizationId === null) {
      // Recorded for replay protection, applied to nobody.
      const { count } = await this.tenant.runForOrganization(
        null,
        async () =>
          await this.prisma.billingWebhookEvent.createMany({
            data: [
              {
                provider: kind,
                externalEventId: event.id,
                type: event.type,
                organizationId: null,
                payloadSha256,
                processedAt: new Date(),
              },
            ],
            skipDuplicates: true,
          }),
      );
      this.logger.warn({ msg: 'billing webhook for an unknown customer', eventId: event.id });
      return count === 0 ? 'duplicate' : 'ignored';
    }

    try {
      await this.tenant.runForOrganization(organizationId, () =>
        this.prisma.runInTransaction(async (tx) => {
          await tx.billingWebhookEvent.create({
            data: {
              provider: kind,
              externalEventId: event.id,
              type: event.type,
              organizationId,
              payloadSha256,
              processedAt: new Date(),
            },
          });
          await this.apply(kind, event, tx);
        }),
      );
      return 'processed';
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The constraint name in `meta` depends on the driver; the row itself
        // is the reliable answer to "was this event already recorded?".
        // Awaited inside the callback: a Prisma query is lazy and would
        // otherwise run after the tenant context has been left.
        const recorded = await this.tenant.runForOrganization(
          organizationId,
          async () =>
            await this.prisma.scoped.billingWebhookEvent.count({
              where: { organizationId, provider: kind, externalEventId: event.id },
            }),
        );
        if (recorded > 0) {
          return 'duplicate';
        }
        // An invoice or subscription id another organization already owns.
        throw new ValidationError('The webhook references an object owned elsewhere');
      }
      throw error;
    }
  }

  private async apply(
    kind: BillingProviderKind,
    event: BillingEvent,
    tx: PrismaTransaction,
  ): Promise<void> {
    if (event.type === 'invoice.updated') {
      await this.applyInvoice(kind, event, tx);
    } else {
      await this.applySubscription(kind, event, tx);
    }

    const subscription = await this.billing.findSubscription(tx);
    await this.billing.cachePlan(this.limits.effectivePlanOf(subscription).plan, tx);
  }

  private async applySubscription(
    kind: BillingProviderKind,
    event: Extract<BillingEvent, { type: 'subscription.updated' }>,
    tx: PrismaTransaction,
  ): Promise<void> {
    const snapshot = event.subscription;
    const eventAt = new Date(event.createdAt);
    const existing = await this.billing.findSubscription(tx);
    if (existing?.lastEventAt != null && existing.lastEventAt > eventAt) {
      // Webhooks are not ordered. An older snapshot must not undo a newer one.
      return;
    }

    const data = {
      provider: kind,
      externalSubscriptionId: snapshot.externalSubscriptionId,
      plan: snapshot.plan,
      status: snapshot.status,
      trialEndsAt: null,
      currentPeriodStart: date(snapshot.currentPeriodStart),
      currentPeriodEnd: date(snapshot.currentPeriodEnd),
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      pendingPlan: snapshot.pendingPlan,
      pastDueSince: date(snapshot.pastDueSince),
      canceledAt: date(snapshot.canceledAt),
      lastEventAt: eventAt,
    };

    const organizationId = this.tenant.organizationId as string;
    if (existing === null) {
      await tx.subscription.create({ data: { ...data, organizationId } });
    } else {
      await this.billing.updateSubscription(data, tx);
    }

    await this.audit.record(
      {
        action: existing === null ? AuditAction.create : AuditAction.update,
        entityType: 'subscription',
        entityId: existing?.id ?? snapshot.externalSubscriptionId,
        summary: `Subscription is ${snapshot.status} on ${snapshot.plan}${
          snapshot.cancelAtPeriodEnd ? ', canceling at period end' : ''
        }${snapshot.pendingPlan === null ? '' : `, moving to ${snapshot.pendingPlan}`}`,
        changes: {
          eventId: event.id,
          from:
            existing === null
              ? null
              : { plan: existing.plan, status: existing.status, pendingPlan: existing.pendingPlan },
          to: { plan: snapshot.plan, status: snapshot.status, pendingPlan: snapshot.pendingPlan },
        },
      },
      tx,
    );
  }

  private async applyInvoice(
    kind: BillingProviderKind,
    event: Extract<BillingEvent, { type: 'invoice.updated' }>,
    tx: PrismaTransaction,
  ): Promise<void> {
    const invoice = event.invoice;
    const organizationId = this.tenant.organizationId as string;
    const data = {
      number: invoice.number,
      status: invoice.status,
      plan: invoice.plan,
      amountDueCents: invoice.amountDueCents,
      amountPaidCents: invoice.amountPaidCents,
      currency: invoice.currency,
      periodStart: date(invoice.periodStart),
      periodEnd: date(invoice.periodEnd),
      hostedUrl: invoice.hostedUrl,
      issuedAt: new Date(invoice.issuedAt),
    };

    const { count } = await tx.invoice.updateMany({
      where: { organizationId, provider: kind, externalInvoiceId: invoice.externalInvoiceId },
      data,
    });
    if (count === 0) {
      await tx.invoice.create({
        data: {
          ...data,
          organizationId,
          provider: kind,
          externalInvoiceId: invoice.externalInvoiceId,
        },
      });
    }

    await this.audit.record(
      {
        action: count === 0 ? AuditAction.create : AuditAction.update,
        entityType: 'invoice',
        entityId: invoice.externalInvoiceId,
        summary: `Invoice ${invoice.number} is ${invoice.status}`,
        changes: {
          eventId: event.id,
          status: invoice.status,
          amountDueCents: invoice.amountDueCents,
        },
      },
      tx,
    );
  }
}
