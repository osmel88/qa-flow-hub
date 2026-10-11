import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../../../config/app-config.service';
import { Env, validateEnv } from '../../../config/env.schema';
import { InvalidWebhookError } from '../../../errors';
import { WebhookDelivery } from '../billing-provider';
import { SIGNATURE_HEADER, signWebhook } from '../webhook-signature';
import { MockBillingProvider } from './mock-billing.provider';
import { MockBillingStore } from './mock-billing.store';

const env = validateEnv({
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_ACCESS_SECRET: 'Kx7fQ2mZp9LwR4tV8nB1cY6hJ3sD5gAe',
  JWT_REFRESH_SECRET: 'Wq4eT8yU1iO6pA3sD9fG2hJ7kL5zX0cV',
  BILLING_WEBHOOK_SECRET: 'unit-test-billing-webhook-secret-0123456789',
});

describe('MockBillingProvider', () => {
  let store: MockBillingStore;
  let provider: MockBillingProvider;

  const parse = (delivery: WebhookDelivery, now = new Date()) =>
    provider.parseWebhook(delivery.rawBody, delivery.headers, now);

  const paidCustomer = async (plan: 'team' | 'business' = 'team') => {
    const { externalCustomerId } = await provider.createCustomer({
      organizationId: 'org_1',
      email: 'owner@example.test',
      name: 'Acme',
    });
    const { sessionId } = await provider.createCheckoutSession({ externalCustomerId, plan });
    provider.completeCheckout(sessionId, externalCustomerId, 'succeeded');
    const subscription = [...store.subscriptions.values()][0];
    if (subscription === undefined) {
      throw new Error('no subscription');
    }
    return { externalCustomerId, sessionId, subscription };
  };

  beforeEach(() => {
    store = new MockBillingStore();
    provider = new MockBillingProvider(
      store,
      new AppConfigService(new ConfigService<Env, true>(env)),
    );
  });

  it('reports a paid checkout only through signed webhooks that verify', async () => {
    const { externalCustomerId } = await paidCustomer('business');
    const deliveries = provider.drainOutbox();
    expect(deliveries).toHaveLength(2);
    const events = deliveries.map((delivery) => parse(delivery));
    expect(events.map((event) => event.type)).toEqual(['invoice.updated', 'subscription.updated']);
    expect(events.every((event) => event.externalCustomerId === externalCustomerId)).toBe(true);
    const invoice = events[0];
    expect(invoice?.type === 'invoice.updated' && invoice.invoice).toMatchObject({
      status: 'paid',
      amountPaidCents: 19900,
    });
    expect(provider.drainOutbox()).toHaveLength(0);
  });

  it('refuses a delivery whose body or signature was tampered with', async () => {
    await paidCustomer();
    const [delivery] = provider.drainOutbox();
    if (delivery === undefined) {
      throw new Error('no delivery');
    }
    const tampered = Buffer.from(delivery.rawBody.toString().replace('"paid"', '"void"'));
    expect(() => provider.parseWebhook(tampered, delivery.headers, new Date())).toThrow(
      InvalidWebhookError,
    );
    expect(() => provider.parseWebhook(delivery.rawBody, {}, new Date())).toThrow(
      InvalidWebhookError,
    );
    const late = new Date(Date.now() + 10 * 60 * 1000);
    expect(() => parse(delivery, late)).toThrow(InvalidWebhookError);
  });

  it('refuses signed payloads with unknown fields, such as a tenant id', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'invoice.updated',
      createdAt: new Date().toISOString(),
      externalCustomerId: 'cus_1',
      organizationId: 'org_other',
      invoice: {},
    });
    const headers = {
      [SIGNATURE_HEADER]: signWebhook(
        env.BILLING_WEBHOOK_SECRET,
        body,
        Math.floor(Date.now() / 1000),
      ),
    };
    expect(() => provider.parseWebhook(Buffer.from(body), headers, new Date())).toThrow(
      InvalidWebhookError,
    );
    expect(() =>
      provider.parseWebhook(
        Buffer.from('not json'),
        {
          [SIGNATURE_HEADER]: signWebhook(
            env.BILLING_WEBHOOK_SECRET,
            'not json',
            Math.floor(Date.now() / 1000),
          ),
        },
        new Date(),
      ),
    ).toThrow(InvalidWebhookError);
  });

  it('upgrades now with a prorated invoice and downgrades at the end of the period', async () => {
    const { subscription } = await paidCustomer('team');
    provider.drainOutbox();
    await provider.changePlan({
      externalSubscriptionId: subscription.externalSubscriptionId,
      plan: 'business',
      atPeriodEnd: false,
    });
    expect(subscription.plan).toBe('business');
    const upgrade = provider.drainOutbox().map((delivery) => parse(delivery));
    const prorated = upgrade.find((event) => event.type === 'invoice.updated');
    expect(prorated?.type === 'invoice.updated' && prorated.invoice.amountDueCents).toBe(
      19900 - 4900,
    );

    await provider.changePlan({
      externalSubscriptionId: subscription.externalSubscriptionId,
      plan: 'team',
      atPeriodEnd: true,
    });
    expect(subscription).toMatchObject({ plan: 'business', pendingPlan: 'team' });
    provider.endPeriod(subscription.externalSubscriptionId, 'succeeded');
    expect(subscription).toMatchObject({ plan: 'team', pendingPlan: null, status: 'active' });
  });

  it('cancels at period end, and a failed renewal starts past_due once', async () => {
    const { subscription } = await paidCustomer();
    provider.endPeriod(subscription.externalSubscriptionId, 'failed');
    const firstFailure = subscription.pastDueSince;
    expect(subscription.status).toBe('past_due');
    provider.endPeriod(subscription.externalSubscriptionId, 'failed');
    expect(subscription.pastDueSince).toBe(firstFailure);

    await provider.cancelAtPeriodEnd(subscription.externalSubscriptionId);
    provider.endPeriod(subscription.externalSubscriptionId, 'succeeded');
    expect(subscription.status).toBe('canceled');
    expect(subscription.canceledAt).not.toBeNull();
    expect(() => provider.endPeriod(subscription.externalSubscriptionId, 'succeeded')).toThrow();
  });

  it('never shows one customer another customer’s checkout session', async () => {
    const { sessionId } = await paidCustomer();
    expect(() => provider.session(sessionId, 'cus_someone_else')).toThrow();
    expect(() =>
      provider.completeCheckout(sessionId, [...store.customers.keys()][0] ?? '', 'succeeded'),
    ).toThrow(/no longer open/);
  });
});
