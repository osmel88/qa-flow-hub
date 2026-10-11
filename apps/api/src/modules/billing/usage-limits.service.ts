import { Injectable } from '@nestjs/common';
import {
  EffectivePlan,
  LimitedResource,
  PLAN_CATALOG,
  PlanUsage,
  resolveEffectivePlan,
  withinLimit,
} from '@qa-flow-hub/shared';
import { Subscription } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { PlanLimitReachedError } from '../../errors';
import { BillingRepository } from './billing.repository';

/**
 * Server-side enforcement of plan limits. The UI may hide a button; this is
 * what actually refuses the request, whatever client sent it.
 *
 * Only *creation* is limited: nothing existing is deleted, hidden or made
 * read-only when an organization ends up above its plan (S2-F11 decision 3A).
 */
@Injectable()
export class UsageLimitsService {
  constructor(
    private readonly billing: BillingRepository,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  effectivePlanOf(subscription: Subscription | null, now: Date = new Date()): EffectivePlan {
    return resolveEffectivePlan(subscription, now, this.config.billing.pastDueGraceDays);
  }

  async usage(tx?: PrismaTransaction): Promise<PlanUsage> {
    const [projects, members, storage] = await Promise.all([
      this.billing.countUsage('projects', tx),
      this.billing.countUsage('members', tx),
      this.billing.countUsage('storage', tx),
    ]);
    return { projects, members, storage };
  }

  /**
   * Runs `work` in a transaction that holds the organization's lock for
   * `resource`, after checking that `adding` more units fit the effective plan.
   * The count and the insert share the transaction and the lock, so concurrent
   * requests are admitted one at a time and the last one that fits wins.
   */
  async guard<T>(
    resource: LimitedResource,
    adding: number,
    work: (tx: PrismaTransaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.runInTransaction(async (tx) => {
      await this.assertWithin(resource, adding, tx);
      return work(tx);
    });
  }

  /**
   * The check alone, for callers that already own a transaction (accepting an
   * invitation). Takes the lock on that transaction.
   */
  async assertWithin(
    resource: LimitedResource,
    adding: number,
    tx: PrismaTransaction,
  ): Promise<void> {
    await this.billing.lockUsage(resource, tx);
    const subscription = await this.billing.findSubscription(tx);
    const { plan } = this.effectivePlanOf(subscription);
    const limit = PLAN_CATALOG[plan].limits[resource];
    if (limit === null) {
      return;
    }
    const used = await this.billing.countUsage(resource, tx);
    if (!withinLimit(limit, used, adding)) {
      throw new PlanLimitReachedError(resource, plan, limit, used);
    }
  }
}
