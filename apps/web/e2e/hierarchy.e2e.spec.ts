import { expect, test } from '@playwright/test';

/**
 * Hierarchy (S4-F3): the owner builds epic → story, sees the rollup, moves a
 * story under the epic from the tree, collapses and expands it, and searches
 * inside the tree.
 */
const unique = Date.now();
const owner = {
  email: `e2e-tree-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Tree Owner',
};

test('hierarchy tree with rollups, reparenting, collapse and search', async ({ page }) => {
  await test.step('the owner creates an epic and two stories', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Tree ${unique}`);
    await page.getByLabel('Slug').fill(`tree-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Tree');
    await page.getByLabel('Key').fill('TRE');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'TRE', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    await page.getByLabel('Title').fill('Checkout revamp');
    await page.getByLabel('Type', { exact: true }).selectOption('epic');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Checkout revamp' })).toBeVisible();
    await page.getByLabel('Type', { exact: true }).selectOption('story');
    await page.getByLabel('Title').fill('Saved cards');
    await page.getByLabel('Estimate').fill('5');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Saved cards' })).toBeVisible();
    await page.getByLabel('Title').fill('Coupon codes');
    await page.getByLabel('Estimate').fill('3');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Coupon codes' })).toBeVisible();
  });

  await test.step('both stories are moved under the epic from the tree', async () => {
    await page.getByRole('link', { name: 'Hierarchy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Hierarchy' })).toBeVisible();
    await page.getByLabel('Move TRE-W-2 under').selectOption({ label: 'TRE-W-1 Checkout revamp' });
    await expect(page.getByTestId('rollup-TRE-W-1')).toHaveText('0/1 done (0%) · 5 estimated');
    await page.getByLabel('Move TRE-W-3 under').selectOption({ label: 'TRE-W-1 Checkout revamp' });
    await expect(page.getByTestId('rollup-TRE-W-1')).toHaveText('0/2 done (0%) · 8 estimated');
  });

  await test.step('the epic collapses and expands, and search keeps the context', async () => {
    await page.getByRole('button', { name: 'Collapse TRE-W-1' }).click();
    await expect(page.getByTestId('tree-node-TRE-W-2')).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand TRE-W-1' }).click();
    await expect(page.getByTestId('tree-node-TRE-W-2')).toBeVisible();

    await page.getByLabel('Search tree').fill('coupon');
    await expect(page.getByTestId('tree-node-TRE-W-3')).toBeVisible();
    await expect(page.getByTestId('tree-node-TRE-W-1')).toBeVisible();
    await expect(page.getByTestId('tree-node-TRE-W-2')).toHaveCount(0);
  });

  await test.step('the story detail shows the breadcrumb to the epic', async () => {
    await page.getByRole('link', { name: 'Coupon codes' }).click();
    await expect(page.getByRole('navigation', { name: 'Ancestors' })).toContainText(
      'TRE-W-1 Checkout revamp',
    );
  });
});
