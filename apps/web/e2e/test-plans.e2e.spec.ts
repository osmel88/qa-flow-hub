import { expect, test } from '@playwright/test';

/**
 * Test plans (S7-F1), everything local: a plan over a suite is started (its
 * scope freezes), a run is attached and executed, and the plan's progress
 * reflects the result before the plan is completed.
 */
const unique = Date.now();
const owner = {
  email: `e2e-plans-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Plans Owner',
};

test('a test plan freezes its scope, tracks a run and completes', async ({ page }) => {
  const openPlan = async () => {
    await page.getByRole('link', { name: 'Test plans', exact: true }).click();
    await page.getByRole('link', { name: 'Checkout plan' }).click();
    await expect(page.getByRole('heading', { name: 'Test plan Checkout plan' })).toBeVisible();
  };

  await test.step('the owner sets up a suite with two cases and a plan', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Plans ${unique}`);
    await page.getByLabel('Slug').fill(`plans-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Plans');
    await page.getByLabel('Key').fill('TPL');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'TPL', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    for (const title of ['Pay with a valid card', 'Pay with an expired card']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Create case' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }
    await page.getByRole('link', { name: 'Test plans', exact: true }).click();
    await expect(page.getByText('No test plan yet.')).toBeVisible();
    await page.getByLabel('Plan name').fill('Checkout plan');
    await page.getByLabel('Plan suite').selectOption({ label: 'Checkout' });
    await page.getByRole('button', { name: 'Create test plan' }).click();
    await expect(page.getByTestId('plan-Checkout plan')).toContainText('draft');
  });

  await test.step('starting the plan freezes its scope', async () => {
    await openPlan();
    await expect(page.getByTestId('plan-scope')).toContainText('2 cases · live scope');
    await page.getByRole('button', { name: 'Start plan' }).click();
    await expect(page.getByTestId('plan-status')).toHaveText('active');
    await expect(page.getByTestId('plan-scope')).toContainText('scope frozen (v1)');
    await expect(page.getByTestId('plan-completion')).toHaveText('Completion: 0%');
  });

  await test.step('a run is attached and executed, and the plan reflects it', async () => {
    await page.getByRole('link', { name: 'Test runs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Test runs', level: 1 })).toBeVisible();
    await page.getByLabel('Name').fill('Plan run');
    await page.getByRole('button', { name: 'Create run' }).click();
    await expect(page.getByRole('link', { name: 'Plan run' })).toBeVisible();
    await openPlan();
    await page.getByLabel('Attach run').selectOption({ label: 'Plan run' });
    await page.getByRole('button', { name: 'Attach run' }).click();
    await expect(page.getByRole('list', { name: 'Plan runs' })).toContainText('Plan run');
    await expect(page.getByTestId('plan-coverage')).toContainText('2/2 (100%)');
    await page
      .getByRole('list', { name: 'Plan runs' })
      .getByRole('link', { name: 'Plan run' })
      .click();
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.getByRole('button', { name: /TPL-C-1/ }).click();
    await page.getByRole('button', { name: 'passed', exact: true }).click();
    await expect(page.locator('.run-case', { hasText: 'TPL-C-1' })).toContainText('passed');
    await openPlan();
    await expect(page.getByTestId('plan-completion')).toHaveText('Completion: 50%');
    await expect(page.getByTestId('plan-pass-rate')).toHaveText('Pass rate: 100%');
    await expect(page.getByTestId('plan-case-TPL-C-1')).toContainText('passed');
  });

  await test.step('the plan is completed and becomes read-only', async () => {
    await page.getByRole('button', { name: 'Complete plan' }).click();
    await expect(page.getByTestId('plan-status')).toHaveText('completed');
    await expect(page.getByRole('button', { name: 'Attach run' })).toHaveCount(0);
  });
});
