import { expect, test } from '@playwright/test';

/**
 * KPI and analytics dashboards (S2-F9): execute a small run with one pass and
 * one failure, then read the numbers back from the project and organization
 * dashboards. Every figure is computed by the API from the real database, so
 * this proves the aggregation, the window and the rendering agree.
 */
const unique = Date.now();
const account = {
  email: `e2e-analytics-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Analytics Lead',
};

test('the dashboards report the KPIs of what was executed', async ({ page }) => {
  await test.step('set up an organization, a project, a requirement and two cases', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();

    await page.getByLabel('Name').fill(`Analytics ${unique}`);
    await page.getByLabel('Slug').fill(`analytics-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Requirements' }).click();
    await page.getByLabel('Title').fill('Refunds reach the card');
    await page.getByRole('button', { name: 'Create requirement' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-R-1' })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    for (const title of ['Pay with a valid card', 'Pay with an expired card']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Create case' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }
  });

  await test.step('execute: one pass, one failure', async () => {
    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Name').fill('Release 2.0');
    await page.getByRole('button', { name: 'Create run' }).click();
    await page.getByRole('link', { name: 'Release 2.0' }).click();
    await page.getByRole('button', { name: 'Start run' }).click();

    await page.getByRole('button', { name: /WEB-C-1/ }).click();
    await page.getByRole('button', { name: 'passed', exact: true }).click();
    await expect(page.locator('.run-case', { hasText: 'WEB-C-1' })).toContainText('passed');

    await page.getByRole('button', { name: /WEB-C-2/ }).click();
    await page.getByLabel('Comment').fill('Expired cards are accepted');
    await page.getByRole('button', { name: 'failed', exact: true }).click();
    await expect(page.getByText('Raise a defect linked to it?')).toBeVisible();
  });

  await test.step('the project dashboard shows the computed KPIs', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    const metric = (label: string) => page.locator('.metric', { hasText: label });

    await expect(metric('Pass rate')).toContainText('50%');
    await expect(metric('Failed rate')).toContainText('50%');
    await expect(metric('Execution progress')).toContainText('100%');
    await expect(metric('Executed vs pending')).toContainText('2 / 0');
    await expect(metric('Coverage')).toContainText('0 of 1 requirements');
    await expect(page.getByText('Open defects', { exact: true })).toBeVisible();

    const uncovered = page.getByRole('region', { name: 'Requirements without coverage' });
    await expect(uncovered).toContainText('Refunds reach the card');

    const distribution = page.getByRole('region', { name: 'Result distribution' });
    await expect(distribution.getByRole('row', { name: /failed 1 50%/i })).toBeVisible();

    const runs = page.getByRole('region', { name: 'Runs in this window' });
    await expect(runs.getByRole('row', { name: /Release 2\.0/ })).toContainText('50%');

    await expect(page.getByRole('img', { name: /Pass rate and coverage/ })).toBeVisible();
  });

  await test.step('the organization view ranks the project and lists the activity', async () => {
    await page.getByRole('button', { name: 'Organization' }).click();
    await expect(page.getByRole('heading', { name: 'Overall QA health' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Most failures' })).toContainText('1 failed');
    await expect(page.getByRole('region', { name: 'Least coverage' })).toContainText('WEB');
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    await expect(page.getByText('WEB · result').first()).toBeVisible();

    await page.getByLabel('Window').selectOption({ label: 'Last 7 days' });
    await expect(page.locator('.metric', { hasText: 'Pass rate' })).toContainText('50%');
  });
});
