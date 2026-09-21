import { expect, test } from '@playwright/test';

/**
 * Email notifications (S2-F6): an owner invites someone, sees the resulting
 * mail in the ledger and in the development outbox with its token redacted,
 * and turns a category off from the profile. Everything runs against a real
 * API with the mock provider, so the tenant header, the role gate and the
 * redaction are the real ones.
 */
const unique = Date.now();
const account = {
  email: `e2e-notifications-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Notification Owner',
};
const invitee = `invitee-${unique}@example.com`;

test('an owner sees the invitation mail in the mock outbox and tunes preferences', async ({
  page,
}) => {
  await test.step('register and create the organization', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();

    await page.getByLabel('Name').fill(`Notifications ${unique}`);
    await page.getByLabel('Slug').fill(`notifications-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('the outbox starts empty and the provider is the mock', async () => {
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
    await expect(page.getByText(/Email provider:/)).toContainText('mock');
    await expect(page.getByRole('heading', { name: /Mock outbox/ })).toBeVisible();
    await expect(page.getByText('No captured emails yet')).toBeVisible();
  });

  let token = '';
  await test.step('invite someone', async () => {
    await page.getByRole('link', { name: 'Members' }).click();
    await page.getByLabel('Email').fill(invitee);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const issued = page.getByRole('status').locator('code');
    await expect(issued).toBeVisible();
    token = (await issued.textContent()) ?? '';
    expect(token.length).toBeGreaterThan(20);
  });

  await test.step('the mail shows up in the organization ledger and the outbox, token redacted', async () => {
    await page.getByRole('link', { name: 'Notifications' }).click();
    await page.getByLabel('Scope').selectOption('organization');
    const row = page.getByRole('row', { name: new RegExp(invitee) });
    await expect(row).toContainText('organization invitation');
    await expect(row.locator('.ui-badge')).toHaveText('sent');

    const outbox = page.getByRole('region', { name: /Mock outbox/ });
    const mail = outbox.locator('details').filter({ hasText: invitee });
    await mail.locator('summary').click();
    await expect(mail.locator('pre')).toContainText('has invited you');
    await expect(mail.locator('pre')).toContainText('?[redacted]');
    await expect(mail.locator('pre')).not.toContainText(token);
    await expect(page.locator('body')).not.toContainText(token);
  });

  await test.step('addressed to me is empty: the invitation went to somebody else', async () => {
    await page.getByLabel('Scope').selectOption('mine');
    await expect(page.getByText('No notifications yet.')).toBeVisible();
  });

  await test.step('turn off test run assignment emails from the profile', async () => {
    await page.getByRole('link', { name: 'Profile' }).click();
    const preferences = page.getByRole('region', { name: 'Notification preferences' });
    const runs = preferences.getByLabel('Test run assignments');
    await expect(runs).toBeChecked();
    await runs.click();
    await expect(runs).not.toBeChecked();

    await page.reload();
    await expect(preferences.getByLabel('Test run assignments')).not.toBeChecked();
    await expect(preferences.getByLabel('Defect assignments')).toBeChecked();
  });

  await test.step('the master switch greys out the categories', async () => {
    const preferences = page.getByRole('region', { name: 'Notification preferences' });
    await preferences.getByLabel('Email notifications').click();
    await expect(preferences.getByLabel('Email notifications')).not.toBeChecked();
    await expect(preferences.getByLabel('Defect assignments')).toBeDisabled();
    await preferences.getByLabel('Email notifications').click();
    await expect(preferences.getByLabel('Email notifications')).toBeChecked();
    await expect(preferences.getByLabel('Defect assignments')).toBeEnabled();
  });
});
