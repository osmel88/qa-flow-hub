import { Injectable } from '@nestjs/common';
import type { PaidPlanName } from '@qa-flow-hub/shared';
import type { ProviderSubscriptionSnapshot, WebhookDelivery } from '../billing-provider';

export interface MockCustomer {
  externalCustomerId: string;
  organizationId: string;
  email: string;
}

export interface MockCheckoutSession {
  sessionId: string;
  externalCustomerId: string;
  plan: PaidPlanName;
  status: 'open' | 'completed' | 'failed';
}

export interface MockSubscription extends ProviderSubscriptionSnapshot {
  externalCustomerId: string;
}

/**
 * The simulated provider's own database, in memory. It is the provider's
 * truth, deliberately separate from ours: tests prove that our tables follow
 * it only through webhooks. Lost on restart, like any mock.
 */
@Injectable()
export class MockBillingStore {
  readonly customers = new Map<string, MockCustomer>();
  readonly sessions = new Map<string, MockCheckoutSession>();
  readonly subscriptions = new Map<string, MockSubscription>();
  invoiceSequence = 0;
  /** Signed deliveries waiting to be handed to the webhook endpoint. */
  outbox: WebhookDelivery[] = [];
  /** Every delivery ever produced, so tests can replay one. */
  readonly delivered: WebhookDelivery[] = [];

  reset(): void {
    this.customers.clear();
    this.sessions.clear();
    this.subscriptions.clear();
    this.invoiceSequence = 0;
    this.outbox = [];
    this.delivered.length = 0;
  }
}
