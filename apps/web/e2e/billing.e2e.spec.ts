import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Billing (S2-F11) against the mock provider: the trial a new organization
 * starts with, a plan limit refusing new work without touching existing data,
 * a mock checkout whose signed webhooks — not the click — change the plan,
 * the invoice it produces, cancellation, webhook replay protection, and a
 * tenant switch that never shows the previous organization's billing.
 */
const unique = Date.now();
const owner = {
  email: `e2e-billing-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Billing Owner',
};
const WEBHOOK_SECRET =
  process.env['E2E_BILLING_WEBHOOK_SECRET'] ??
  'development-only-billing-webhook-secret-not-for-production';

async function createProject(page: Page, key: string): Promise<void> {
  await page.getByLabel('Name').fill(`Project ${key}`);
  await page.getByLabel('Key').fill(key);
  await page.getByRole('button', { name: 'Create project' }).click();
}

function signed(body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-qaflow-signature': `t=${timestamp},v1=${digest}`,
  };
}

test('plan, limits, mock checkout, invoices and cancellation', async ({ page }) => {
  await test.step('a new organization starts on a Team trial', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Billing A ${unique}`);
    await page.getByLabel('Slug').fill(`billing-a-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('billing-banner')).toContainText('Team trial');

    await page.getByRole('link', { name: 'Billing', exact: true }).first().click();
    await expect(page.getByTestId('billing-summary')).toContainText('Trial of Team until');
  });

  await test.step('ending the trial falls back to Free', async () => {
    await page.getByRole('button', { name: 'End trial' }).click();
    await expect(page.getByTestId('billing-summary')).toContainText('canceled');
    await expect(page.getByRole('heading', { name: /Free plan/ })).toBeVisible();
  });

  await test.step('the Free limit refuses the fourth project and keeps the other three', async () => {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects' })
      .click();
    for (const key of ['BA', 'BB', 'BC']) {
      await createProject(page, key);
      await expect(page.getByRole('cell', { name: key, exact: true })).toBeVisible();
    }
    await createProject(page, 'BD');
    await expect(page.getByRole('alert')).toContainText('Nothing existing was removed');
    await expect(page.getByRole('cell', { name: 'BD', exact: true })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'BC', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'See plans and usage' }).click();
    await expect(page.getByTestId('usage-projects')).toContainText('3 / 3');
    await expect(page.getByTestId('usage-projects')).toContainText('Approaching the limit');
  });

  await test.step('a mock checkout upgrades only once its webhooks are applied', async () => {
    await page.getByRole('button', { name: 'Upgrade to Team' }).click();
    await expect(page.getByRole('heading', { name: 'Checkout (mock provider)' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay' }).click();
    await expect(page.getByTestId('billing-summary')).toContainText('Renews on');
    await expect(page.getByRole('heading', { name: /Team plan/ })).toBeVisible();
    await expect(page.getByTestId('usage-projects')).toContainText('3 / 25');
    const invoices = page.getByRole('region', { name: 'Invoices' });
    await expect(invoices.getByRole('cell', { name: '$49.00' })).toBeVisible();
    await expect(invoices.getByText('Paid')).toBeVisible();
  });

  await test.step('cancellation is scheduled for the end of the period', async () => {
    await page.getByRole('button', { name: 'Cancel at period end' }).click();
    await expect(page.getByTestId('billing-summary')).toContainText('Cancels on');
    await page.getByRole('button', { name: 'Keep subscription' }).click();
    await expect(page.getByTestId('billing-summary')).toContainText('Renews on');
  });

  await test.step('webhooks: an unsigned one is refused, a replayed one is a duplicate', async () => {
    const body = JSON.stringify({
      id: `evt_e2e_${unique}`,
      type: 'subscription.updated',
      createdAt: new Date().toISOString(),
      externalCustomerId: `cus_e2e_unknown_${unique}`,
      subscription: {
        externalSubscriptionId: `sub_e2e_${unique}`,
        plan: 'business',
        status: 'active',
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        pendingPlan: null,
        pastDueSince: null,
        canceledAt: null,
      },
    });
    const unsigned = await page.request.post('/api/v1/billing/webhooks/mock', {
      headers: { 'content-type': 'application/json' },
      data: body,
    });
    expect(unsigned.status()).toBe(400);

    const headers = signed(body);
    const first = await page.request.post('/api/v1/billing/webhooks/mock', { headers, data: body });
    expect(await first.json()).toEqual({ received: true, outcome: 'ignored' });
    const replay = await page.request.post('/api/v1/billing/webhooks/mock', {
      headers,
      data: body,
    });
    expect(await replay.json()).toEqual({ received: true, outcome: 'duplicate' });

    await page.reload();
    await expect(page.getByRole('heading', { name: /Team plan/ })).toBeVisible();
  });

  await test.step('switching tenant never shows the previous organization’s billing', async () => {
    await page.goto('/organizations');
    await page.getByLabel('Name').fill(`Billing B ${unique}`);
    await page.getByLabel('Slug').fill(`billing-b-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Billing' })
      .click();
    await expect(page.getByTestId('billing-summary')).toContainText('Trial of Team until');
    await expect(page.getByTestId('usage-projects')).toContainText('0 / 25');
    await expect(
      page.getByRole('region', { name: 'Invoices' }).getByText('No invoices yet.'),
    ).toBeVisible();

    await page.getByLabel('Organization').selectOption({ label: `Billing A ${unique}` });
    await expect(page.getByTestId('billing-summary')).toContainText('Renews on');
    await expect(page.getByTestId('usage-projects')).toContainText('3 / 25');
  });
});
