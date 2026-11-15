import { expect, test } from '@playwright/test';

/**
 * Exploratory testing (S7-F5), everything local: a session is planned,
 * started, paused and resumed, records notes and findings, turns one into a
 * defect and becomes read-only history once completed.
 */
const unique = Date.now();
const owner = {
  email: `e2e-explore-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Explorer Owner',
};

test('an exploratory session records findings, creates a defect and freezes', async ({ page }) => {
  await test.step('the owner plans a session', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Explore ${unique}`);
    await page.getByLabel('Slug').fill(`explore-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Explore');
    await page.getByLabel('Key').fill('EXP');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'EXP', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Exploratory testing' }).click();
    await expect(page.getByText('No session yet.')).toBeVisible();
    await page.getByLabel('Session title').fill('Checkout tour');
    await page.getByLabel('Charter').fill('Explore card payments with odd amounts');
    await page.getByLabel('Timebox (minutes)').fill('45');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByTestId('session-Checkout tour')).toContainText('planned');
    await page.getByRole('link', { name: 'Checkout tour' }).click();
    await expect(page.getByRole('heading', { name: 'Session Checkout tour' })).toBeVisible();
  });

  await test.step('the session runs, pauses and resumes while recording', async () => {
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page.getByTestId('session-status')).toHaveText('active');
    await page.getByLabel('Timeline note').fill('Card form loads slowly');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByRole('list', { name: 'Timeline' })).toContainText(
      'Card form loads slowly',
    );
    await page.getByRole('button', { name: 'Pause session' }).click();
    await expect(page.getByTestId('session-status')).toHaveText('paused');
    await page.getByRole('button', { name: 'Resume session' }).click();
    await expect(page.getByTestId('session-status')).toHaveText('active');
    await page.getByLabel('Finding title').fill('Total ignores the coupon');
    await page.getByLabel('Finding severity').selectOption('critical');
    await page.getByRole('button', { name: 'Record finding' }).click();
    await expect(page.getByTestId('finding-Total ignores the coupon')).toContainText('critical');
    await page.getByRole('button', { name: 'Create defect from Total ignores the coupon' }).click();
    await expect(page.getByTestId('finding-Total ignores the coupon')).toContainText(
      'Defect created: EXP-D-1',
    );
    await expect(page.getByTestId('session-metrics')).toContainText(
      '1 findings · 1 defects created',
    );
  });

  await test.step('completing freezes the session as history', async () => {
    await page.getByRole('button', { name: 'Complete session' }).click();
    await expect(page.getByTestId('session-status')).toHaveText('completed');
    await expect(page.getByRole('button', { name: 'Save session' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record finding' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive session' })).toBeVisible();
    const timeline = page.getByRole('list', { name: 'Timeline' });
    for (const entry of [
      'Started',
      'Paused',
      'Resumed',
      'Finding',
      'Defect created',
      'Completed',
    ]) {
      await expect(timeline).toContainText(new RegExp(entry, 'i'));
    }
    await page.getByRole('button', { name: 'Archive session' }).click();
    await expect(page.getByTestId('session-status')).toHaveText('archived');
    await page.getByRole('link', { name: 'Defects', exact: true }).click();
    await expect(page).toHaveURL(/\/defects/);
    await expect(page.getByText('Total ignores the coupon').first()).toBeVisible();
  });
});
