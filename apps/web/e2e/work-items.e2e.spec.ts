import { expect, test } from '@playwright/test';

/**
 * Work items (S4-F1): the owner builds a small backlog (epic → story), plans
 * the story in a release, moves it through statuses, filters the list and
 * sees the hierarchy on the detail page.
 */
const unique = Date.now();
const owner = {
  email: `e2e-work-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Backlog Owner',
};

test('work items backlog with hierarchy, release and filters', async ({ page }) => {
  await test.step('the owner sets up an organization, a project and a release', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Backlog ${unique}`);
    await page.getByLabel('Slug').fill(`backlog-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Backlog');
    await page.getByLabel('Key').fill('BLG');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'BLG', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByLabel('Release name').fill('Winter launch');
    await page.getByLabel('Version').fill('3.0.0');
    await page.getByRole('button', { name: 'Create release' }).click();
    await expect(page.getByRole('link', { name: 'Winter launch' })).toBeVisible();
  });

  await test.step('an epic and a story are added to the backlog', async () => {
    await page.getByRole('link', { name: 'Work items' }).click();
    await expect(page.getByRole('heading', { name: 'Work items' })).toBeVisible();
    await page.getByLabel('Title').fill('Checkout revamp');
    await page.getByLabel('Type', { exact: true }).selectOption('epic');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Checkout revamp' })).toBeVisible();

    await page.getByLabel('Title').fill('Pay with saved cards');
    // The form keeps the last type, so the story is chosen explicitly.
    await page.getByLabel('Type', { exact: true }).selectOption('story');
    await page.getByLabel('Priority', { exact: true }).selectOption('high');
    await page.getByLabel('Estimate').fill('5');
    await page.getByLabel('Labels').fill('Payments, UX');
    await page.getByRole('button', { name: 'Add work item' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Pay with saved cards' });
    await expect(row).toContainText('BLG-W-2');
    await expect(row).toContainText('payments, ux');
    await expect(row).toContainText('story');
  });

  await test.step('the story is placed under the epic, planned and started', async () => {
    await page.getByRole('link', { name: 'Pay with saved cards' }).click();
    await expect(
      page.getByRole('heading', { name: 'BLG-W-2 · Pay with saved cards' }),
    ).toBeVisible();
    await page.getByLabel('Parent').selectOption({ label: 'BLG-W-1 Checkout revamp' });
    await page.getByLabel('Release').selectOption({ label: 'Winter launch (3.0.0)' });
    await page.getByLabel('Status').selectOption('in_progress');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Work item saved.' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Ancestors' })).toContainText(
      'BLG-W-1 Checkout revamp',
    );
    await expect(page.getByText('Version 2')).toBeVisible();
  });

  await test.step('the epic shows its child and the list filters by status', async () => {
    await page.getByRole('link', { name: 'BLG-W-1 Checkout revamp' }).click();
    await expect(page.getByRole('link', { name: 'BLG-W-2 Pay with saved cards' })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    await page.getByLabel('Filter by status').selectOption('in_progress');
    await expect(page.getByRole('link', { name: 'Pay with saved cards' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Checkout revamp' })).toHaveCount(0);
    await page.getByLabel('Filter by status').selectOption('');
    await page.getByLabel('Search').fill('blg-w-1');
    await expect(page.getByRole('link', { name: 'Checkout revamp' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pay with saved cards' })).toHaveCount(0);
  });
});
