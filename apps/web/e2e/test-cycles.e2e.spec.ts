import { expect, test } from '@playwright/test';

/**
 * Test cycles (S7-F2), everything local: a cycle inside an active plan
 * freezes the plan scope, tracks a run and is completed and archived.
 */
const unique = Date.now();
const owner = {
  email: `e2e-cycles-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Cycles Owner',
};

test('a test cycle freezes its plan scope, tracks a run and is archived', async ({ page }) => {
  const openCycle = async () => {
    await page.getByRole('link', { name: 'Test plans', exact: true }).click();
    await page.getByRole('link', { name: 'Release plan' }).click();
    await page.getByRole('link', { name: 'Cycle 1' }).click();
    await expect(page.getByRole('heading', { name: 'Test cycle Cycle 1' })).toBeVisible();
  };

  await test.step('the owner sets up a suite and an active plan', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Cycles ${unique}`);
    await page.getByLabel('Slug').fill(`cycles-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Cycles');
    await page.getByLabel('Key').fill('TCY');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'TCY', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a valid card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('link', { name: 'Pay with a valid card' })).toBeVisible();
    await page.getByRole('link', { name: 'Test plans', exact: true }).click();
    await page.getByLabel('Plan name').fill('Release plan');
    await page.getByLabel('Plan suite').selectOption({ label: 'Checkout' });
    await page.getByRole('button', { name: 'Create test plan' }).click();
    await page.getByRole('link', { name: 'Release plan' }).click();
    await page.getByRole('button', { name: 'Start plan' }).click();
    await expect(page.getByTestId('plan-status')).toHaveText('active');
  });

  await test.step('a cycle is planned and started, freezing the plan scope', async () => {
    await expect(page.getByText('No cycle yet.')).toBeVisible();
    await page.getByLabel('Cycle name').fill('Cycle 1');
    await page.getByRole('button', { name: 'Create cycle' }).click();
    await expect(page.getByTestId('cycle-Cycle 1')).toContainText('planned');
    await page.getByRole('link', { name: 'Cycle 1' }).click();
    await expect(page.getByTestId('cycle-scope')).toContainText('1 cases · follows the plan scope');
    await page.getByRole('button', { name: 'Start cycle' }).click();
    await expect(page.getByTestId('cycle-status')).toHaveText('active');
    await expect(page.getByTestId('cycle-scope')).toContainText('scope frozen from plan v1');
  });

  await test.step('a run is attached and executed, and the cycle reflects it', async () => {
    await page.getByRole('link', { name: 'Test runs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Test runs', level: 1 })).toBeVisible();
    await page.getByLabel('Name').fill('Cycle run');
    await page.getByRole('button', { name: 'Create run' }).click();
    await expect(page.getByRole('link', { name: 'Cycle run' })).toBeVisible();
    await openCycle();
    await page.getByLabel('Attach run to cycle').selectOption({ label: 'Cycle run' });
    await page.getByRole('button', { name: 'Attach run to cycle' }).click();
    await expect(page.getByRole('list', { name: 'Cycle runs' })).toContainText('Cycle run');
    await page
      .getByRole('list', { name: 'Cycle runs' })
      .getByRole('link', { name: 'Cycle run' })
      .click();
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.getByRole('button', { name: /TCY-C-1/ }).click();
    await page.getByRole('button', { name: 'passed', exact: true }).click();
    await expect(page.locator('.run-case', { hasText: 'TCY-C-1' })).toContainText('passed');
    await openCycle();
    await expect(page.getByTestId('cycle-completion')).toHaveText('Completion: 100%');
    await expect(page.getByTestId('cycle-pass-rate')).toHaveText('Pass rate: 100%');
  });

  await test.step('the cycle is completed and archived, keeping its results', async () => {
    await page.getByRole('button', { name: 'Complete cycle' }).click();
    await expect(page.getByTestId('cycle-status')).toHaveText('completed');
    await page.getByRole('button', { name: 'Archive cycle' }).click();
    await expect(page.getByTestId('cycle-status')).toHaveText('archived');
    await expect(page.getByTestId('cycle-counts')).toContainText('passed 1');
    await expect(page.getByRole('button', { name: 'Attach run to cycle' })).toHaveCount(0);
  });
});
