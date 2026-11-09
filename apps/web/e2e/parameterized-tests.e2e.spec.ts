import { expect, test } from '@playwright/test';

/**
 * Parameterized test cases (S7-F3), everything local: a case gets parameters
 * and a dataset, a run executes one row each, and editing the dataset later
 * does not change what was executed.
 */
const unique = Date.now();
const owner = {
  email: `e2e-params-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Params Owner',
};

test('a parameterized case runs once per dataset row and keeps the values used', async ({
  page,
}) => {
  const openCase = async () => {
    await page.getByRole('link', { name: 'Test cases', exact: true }).click();
    await page.getByRole('button', { name: /Checkout/ }).click();
    await page.getByRole('link', { name: 'Pay with a card' }).click();
    await expect(page.getByRole('heading', { name: 'Parameters and dataset' })).toBeVisible();
  };

  await test.step('the owner sets up a case', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Params ${unique}`);
    await page.getByLabel('Slug').fill(`params-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Params');
    await page.getByLabel('Key').fill('PRM');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'PRM', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await page.getByRole('link', { name: 'Pay with a card' }).click();
    await expect(page.getByRole('heading', { name: 'Parameters and dataset' })).toBeVisible();
  });

  await test.step('parameters and two dataset rows are defined and validated', async () => {
    await page.getByRole('button', { name: 'Add parameter' }).click();
    await page.getByLabel('Parameter 1 name').fill('user');
    await page.getByText('Parameter 1 required').click();
    await page.getByRole('button', { name: 'Add parameter' }).click();
    await page.getByLabel('Parameter 2 name').fill('amount');
    await page.getByLabel('Parameter 2 type').selectOption('number');
    await page.getByLabel('Parameter 2 default').fill('10');
    await page.getByRole('button', { name: 'Add row' }).click();
    await page.getByLabel('Row 1 label').fill('Regular');
    await page.getByLabel('Row 1 user').fill('ann');
    await page.getByLabel('Row 1 amount').fill('ten');
    await page.getByRole('button', { name: 'Save parameters' }).click();
    await expect(page.getByRole('alert')).toContainText('Row 1: amount expects a number');
    await page.getByLabel('Row 1 amount').fill('5');
    await page.getByRole('button', { name: 'Add row' }).click();
    await page.getByLabel('Row 2 label').fill('VIP');
    await page.getByRole('button', { name: 'Save parameters' }).click();
    await expect(page.getByRole('alert')).toContainText('user is required');
    await page.getByLabel('Row 2 user').fill('bob');
    await page.getByRole('button', { name: 'Save parameters' }).click();
    await expect(page.getByRole('status')).toContainText('Parameters saved as version 2.');
  });

  await test.step('a run expands one execution per row with independent results', async () => {
    await page.getByRole('link', { name: 'Test runs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Test runs', level: 1 })).toBeVisible();
    await page.getByLabel('Name').fill('Param run');
    await page.getByRole('button', { name: 'Create run' }).click();
    await page.getByRole('link', { name: 'Param run' }).click();
    await page.getByRole('button', { name: /\[Regular\]/ }).click();
    const used = page.getByRole('definition');
    await expect(page.getByLabel('Parameters used')).toContainText('ann');
    await expect(used.filter({ hasText: '5' })).toBeVisible();
    await page.getByRole('button', { name: 'Passed' }).click();
    await expect(page.getByText(/Latest result: passed .* with Regular/i)).toBeVisible();
    await page.getByRole('button', { name: /\[Regular\]/ }).click();
    await page.getByRole('button', { name: /\[VIP\]/ }).click();
    await expect(page.getByLabel('Parameters used')).toContainText('bob');
    await expect(page.getByLabel('Parameters used')).toContainText('10');
    await page.getByRole('button', { name: 'Failed' }).click();
    await expect(page.getByText(/Latest result: failed .* with VIP/i)).toBeVisible();
    await page.getByLabel('Dataset row').selectOption('VIP');
    await expect(page.getByRole('button', { name: /\[Regular\]/ })).toHaveCount(0);
    await expect(page.locator('.run-case')).toHaveCount(1);
    await expect(page.locator('.run-case')).toContainText(/failed/i);
  });

  await test.step('editing the dataset keeps the executed values, and CSV round-trips', async () => {
    await openCase();
    await page.getByLabel('Row 1 user').fill('zed');
    await page.getByRole('button', { name: 'Save parameters' }).click();
    await expect(page.getByRole('status')).toContainText('Parameters saved as version 3.');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export dataset CSV' }).click();
    expect((await download).suggestedFilename()).toContain('dataset.csv');
    await page.getByLabel('Import dataset CSV').setInputFiles({
      name: 'dataset.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('_label,user,amount\nImported,eve,7\nSecond,fay,\n'),
    });
    await expect(page.getByRole('status')).toContainText('Dataset imported as version 4.');
    await expect(page.getByLabel('Row 2 user')).toHaveValue('fay');
    await expect(page.getByLabel('Row 3 user')).toHaveCount(0);

    await page.getByRole('link', { name: 'Test runs', exact: true }).click();
    await page.getByRole('link', { name: 'Param run' }).click();
    await page.getByRole('button', { name: /\[Regular\]/ }).click();
    await expect(page.getByLabel('Parameters used')).toContainText('ann');
    await expect(page.getByLabel('Parameters used')).not.toContainText('zed');
  });
});
