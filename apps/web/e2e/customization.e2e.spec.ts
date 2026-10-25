import { expect, test } from '@playwright/test';

/**
 * Custom fields and the defect workflow (S3-F7): the owner adds a select
 * field to defects, makes it required to triage, removes a transition, and
 * the Defects page follows the project's rules.
 */
const unique = Date.now();
const owner = {
  email: `e2e-custom-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Custom Owner',
};

test('custom fields and a configured defect workflow', async ({ page }) => {
  await test.step('the owner sets up an organization and a project', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Custom ${unique}`);
    await page.getByLabel('Slug').fill(`custom-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Customized');
    await page.getByLabel('Key').fill('CUS');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'CUS', exact: true })).toBeVisible();
  });

  await test.step('a select field is added to defects', async () => {
    await page.getByRole('link', { name: 'Customization' }).click();
    await expect(page.getByRole('heading', { name: 'Custom fields' })).toBeVisible();
    await page.getByLabel('Entity').selectOption({ label: 'Defects' });
    await page.getByLabel('Key').fill('browser');
    await page.getByLabel('Label', { exact: true }).fill('Browser');
    await page.getByLabel('Type').selectOption('select');
    await page.getByLabel('Options').fill('Chrome, Safari');
    await page.getByRole('button', { name: 'Add field' }).click();
    await expect(page.getByRole('cell', { name: 'Chrome, Safari' })).toBeVisible();
  });

  await test.step('triage requires the field and rejecting from open is removed', async () => {
    await page
      .getByLabel('Fields required to move open to triaged')
      .selectOption({ label: 'Browser' });
    await page.getByRole('button', { name: 'Remove open to rejected' }).click();
    await page.getByRole('button', { name: 'Save workflow' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Workflow saved.' })).toBeVisible();
    await expect(page.getByText('Customized (version 1).')).toBeVisible();
  });

  await test.step('the Defects page follows the project rules', async () => {
    await page.getByRole('link', { name: 'Defects' }).click();
    await page.getByLabel('Title').fill('Card declined');
    await page.getByRole('button', { name: 'Report defect' }).click();
    const menu = page.getByLabel(/Change status of/);
    await expect(menu).toHaveCount(1);
    await expect(menu.locator('option', { hasText: 'Rejected' })).toHaveCount(0);

    await menu.selectOption('triaged');
    await expect(page.getByRole('alert')).toContainText('Browser');

    await page.getByLabel('Title').fill('Coupon ignored');
    await page.getByLabel('Browser').selectOption({ label: 'Chrome' });
    await page.getByRole('button', { name: 'Report defect' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Coupon ignored' });
    await expect(row).toContainText('Browser: Chrome');
    await row.getByLabel(/Change status of/).selectOption('triaged');
    await expect(row.getByRole('cell', { name: 'triaged', exact: true })).toBeVisible();
  });
});
