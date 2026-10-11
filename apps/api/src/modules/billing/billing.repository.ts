import { Injectable } from '@nestjs/common';
import {
  BillingCustomer,
  BillingProviderKind,
  Invoice,
  InvitationStatus,
  OrganizationPlan,
  Prisma,
  Subscription,
  SubscriptionStatus,
} from '@prisma/client';
import {
  LimitedResource,
  ListInvoicesQuery,
  Paginated,
  buildPaginationMeta,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

/**
 * Billing rows of the active organization. Every query carries the tenant
 * filter and runs through the RLS client; the only tenant-less read is
 * `organizationForCustomer`, which goes through a SECURITY DEFINER function
 * that can answer nothing but "who owns this customer id".
 */
@Injectable()
export class BillingRepository extends TenantAwareRepository {
  constructor(
    private readonly base: PrismaService,
    tenant: TenantContextService,
  ) {
    super(base, tenant);
  }

  get currentOrganizationId(): string {
    return this.organizationId;
  }

  findSubscription(tx?: PrismaTransaction): Promise<Subscription | null> {
    return (tx ?? this.prisma).subscription.findFirst({ where: this.scope() });
  }

  findCustomer(tx?: PrismaTransaction): Promise<BillingCustomer | null> {
    return (tx ?? this.prisma).billingCustomer.findFirst({ where: this.scope() });
  }

  createCustomer(data: {
    provider: BillingProviderKind;
    externalCustomerId: string;
    email: string;
  }): Promise<BillingCustomer> {
    return this.prisma.billingCustomer.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async listInvoices(query: ListInvoicesQuery): Promise<Paginated<Invoice>> {
    const where = this.scope();
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        ...this.page(query),
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data: rows, meta: buildPaginationMeta(query, total) };
  }

  /**
   * The trial every new organization starts with. Called inside the
   * transaction that creates the organization, before any tenant is announced
   * for the request, so the tenant is set on the transaction itself.
   */
  async startTrial(
    organizationId: string,
    plan: OrganizationPlan,
    trialEndsAt: Date,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, TRUE)`;
    await tx.subscription.create({
      data: {
        organizationId,
        provider: BillingProviderKind.mock,
        plan,
        status: SubscriptionStatus.trialing,
        trialEndsAt,
      },
    });
    await tx.organization.update({ where: { id: organizationId }, data: { plan } });
  }

  /**
   * Cancels the trial only if it is still a trial, under the billing-state
   * lock: a webhook that activated a paid subscription meanwhile wins.
   */
  cancelTrial(now: Date): Promise<Prisma.BatchPayload> {
    return this.base.runInTransaction(async (tx) => {
      await this.lockBillingState(tx);
      return tx.subscription.updateMany({
        where: { ...this.scope(), status: SubscriptionStatus.trialing },
        data: { status: SubscriptionStatus.canceled, canceledAt: now },
      });
    });
  }

  /** Local-only change (a trial has no provider subscription to ask). */
  updateSubscription(
    data: Prisma.SubscriptionUpdateManyMutationInput,
    tx?: PrismaTransaction,
  ): Promise<Prisma.BatchPayload> {
    return (tx ?? this.prisma).subscription.updateMany({ where: this.scope(), data });
  }

  /** Refreshes the cached plan on the organization row. */
  async cachePlan(plan: OrganizationPlan, tx?: PrismaTransaction): Promise<void> {
    await (tx ?? this.prisma).organization.updateMany({
      where: { id: this.organizationId, plan: { not: plan } },
      data: { plan },
    });
  }

  /**
   * Serialises every limit-checked creation of one resource in one
   * organization until the surrounding transaction ends. Without it two
   * concurrent requests at `limit - 1` would both count, both pass, and both
   * insert. Transaction-scoped: released on commit or rollback, never leaked.
   */
  async lockUsage(resource: LimitedResource, tx: PrismaTransaction): Promise<void> {
    const key = `billing:${this.organizationId}:${resource}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * Serialises every change to the organization's subscription and invoices
   * (webhooks, trial cancellation), so the "is this event newer?" check and
   * the write it guards cannot interleave with another one.
   */
  async lockBillingState(tx: PrismaTransaction): Promise<void> {
    const key = `billing:${this.organizationId}:state`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  findInvoice(
    provider: BillingProviderKind,
    externalInvoiceId: string,
    tx: PrismaTransaction,
  ): Promise<Invoice | null> {
    return tx.invoice.findFirst({ where: { ...this.scope(), provider, externalInvoiceId } });
  }

  async countUsage(resource: LimitedResource, tx?: PrismaTransaction): Promise<number> {
    const client = tx ?? this.prisma;
    const organizationId = this.organizationId;
    switch (resource) {
      case 'projects':
        // Archived projects keep their slot: archiving is reversible, deleting is not.
        return client.project.count({ where: { organizationId, deletedAt: null } });
      case 'members': {
        const [members, invitations] = await Promise.all([
          client.organizationMember.count({ where: { organizationId, deletedAt: null } }),
          client.organizationInvitation.count({
            where: {
              organizationId,
              status: InvitationStatus.pending,
              expiresAt: { gt: new Date() },
            },
          }),
        ]);
        return members + invitations;
      }
      case 'storage': {
        const sum = await client.attachmentMetadata.aggregate({
          where: { organizationId, deletedAt: null },
          _sum: { sizeBytes: true },
        });
        return sum._sum.sizeBytes ?? 0;
      }
    }
  }

  async organizationName(): Promise<string> {
    const organization = await this.prisma.organization.findFirst({
      where: { id: this.organizationId, deletedAt: null },
      select: { name: true },
    });
    return organization?.name ?? '';
  }

  /** Tenant resolution for a webhook, which arrives with no tenant at all. */
  async organizationForCustomer(
    provider: BillingProviderKind,
    externalCustomerId: string,
  ): Promise<string | null> {
    const rows = await this.base.$queryRaw<Array<{ organization_id: string | null }>>`
      SELECT billing_organization_for_customer(${provider}::"BillingProviderKind", ${externalCustomerId}) AS organization_id
    `;
    return rows[0]?.organization_id ?? null;
  }
}
