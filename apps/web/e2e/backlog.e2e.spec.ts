import { expect, test } from '@playwright/test';

/**
 * Backlog (S4-F2): the owner reorders the backlog with the arrow buttons and
 * with drag and drop, the order survives a reload, a bulk action changes
 * priority and estimate of two items, and grouping by epic shows totals.
 */
const unique = Date.now();
const owner = {
  email: `e2e-backlog-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Backlog Planner',
};

test('backlog reorder, bulk actions and grouping', async ({ page }) => {
  const keys = async (): Promise<string[]> =>
    page
      .getByRole('table', { name: 'Backlog' })
      .locator('tbody tr[data-testid] code')
      .allTextContents();

  await test.step('the owner sets up a project with an epic and three stories', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Planner ${unique}`);
    await page.getByLabel('Slug').fill(`planner-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Planner');
    await page.getByLabel('Key').fill('PLN');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'PLN', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    await page.getByLabel('Title').fill('Checkout revamp');
    await page.getByLabel('Type', { exact: true }).selectOption('epic');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Checkout revamp' })).toBeVisible();
    await page.getByLabel('Type', { exact: true }).selectOption('story');
    for (const title of ['First story', 'Second story', 'Third story']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Add work item' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }
  });

  await test.step('the backlog is reordered with the arrows and by dragging', async () => {
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    await expect.poll(keys).toEqual(['PLN-W-1', 'PLN-W-2', 'PLN-W-3', 'PLN-W-4']);

    await page.getByRole('button', { name: 'Move PLN-W-4 up' }).click();
    await expect.poll(keys).toEqual(['PLN-W-1', 'PLN-W-2', 'PLN-W-4', 'PLN-W-3']);

    await page.getByTestId('backlog-row-PLN-W-3').dragTo(page.getByTestId('backlog-row-PLN-W-1'));
    await expect.poll(keys).toEqual(['PLN-W-3', 'PLN-W-1', 'PLN-W-2', 'PLN-W-4']);

    await page.reload();
    await expect.poll(keys).toEqual(['PLN-W-3', 'PLN-W-1', 'PLN-W-2', 'PLN-W-4']);
  });

  await test.step('two stories get a priority and an estimate in one bulk action', async () => {
    await page.getByLabel('Select PLN-W-2').check();
    await page.getByLabel('Select PLN-W-3').check();
    await expect(page.getByRole('heading', { name: 'Change 2 selected' })).toBeVisible();
    await page.getByLabel('Set priority').selectOption('high');
    await page.getByLabel('Set estimate').fill('3');
    await page.getByRole('button', { name: 'Apply to 2 items' }).click();
    await expect(page.getByTestId('backlog-totals')).toHaveText(
      '4 items · 6 estimated · 2 unestimated',
    );
    await expect(page.getByTestId('backlog-row-PLN-W-2')).toContainText('high');
  });

  await test.step('grouping by epic separates the epic from loose stories', async () => {
    await page.getByLabel('Group by').selectOption('epic');
    await expect(page.getByRole('rowheader', { name: /PLN-W-1 Checkout revamp/ })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: /No epic/ })).toContainText(
      '3 items · 6 estimated · 1 unestimated',
    );
  });
});
