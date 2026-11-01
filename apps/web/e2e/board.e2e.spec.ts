import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Scrum board (S4-F6): the owner plans three items into an active sprint,
 * reorders and moves cards with the keyboard controls and with drag & drop,
 * reloads to check the board persisted, then filters and groups it.
 */
const unique = Date.now();
const owner = {
  email: `e2e-board-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Board Owner',
};

const cardKeys = (page: Page, column: string) =>
  page
    .getByTestId(`board-column-${column}`)
    .locator('[data-testid^="board-card-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-testid')?.replace('board-card-', '')),
    );

test('scrum board moves, persistence, filters and swimlanes', async ({ page }) => {
  await test.step('the owner plans three items into an active sprint', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Boarder ${unique}`);
    await page.getByLabel('Slug').fill(`boarder-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Boarder');
    await page.getByLabel('Key').fill('BRD');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'BRD', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    for (const title of ['Saved cards', 'Coupon codes', 'Gift cards']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Add work item' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }

    await page.getByRole('link', { name: 'Sprints', exact: true }).click();
    await page.getByLabel('Sprint name').fill('Sprint 1');
    await page.getByLabel('Capacity (points)').fill('10');
    await page.getByRole('button', { name: 'Create sprint' }).click();
    await page.getByRole('link', { name: 'Sprint 1' }).click();
    for (const key of ['BRD-W-1', 'BRD-W-2', 'BRD-W-3']) {
      await page.getByLabel(`Plan ${key}`).check();
    }
    await page.getByRole('button', { name: 'Add to sprint' }).click();
    await expect(
      page.getByRole('table', { name: 'Sprint backlog' }).getByRole('link', { name: 'BRD-W-3' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Start sprint' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sprint started.' })).toBeVisible();
  });

  await test.step('cards move with the keyboard controls and with drag & drop', async () => {
    await page.getByRole('link', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
    await expect.poll(() => cardKeys(page, 'todo')).toEqual(['BRD-W-1', 'BRD-W-2', 'BRD-W-3']);

    await page.getByRole('button', { name: 'Move BRD-W-3 up' }).click();
    await expect.poll(() => cardKeys(page, 'todo')).toEqual(['BRD-W-1', 'BRD-W-3', 'BRD-W-2']);

    await page.getByLabel('Move BRD-W-1 to column').selectOption('done');
    await expect.poll(() => cardKeys(page, 'done')).toEqual(['BRD-W-1']);
    await expect(page.getByTestId('board-progress')).toHaveText('33.3%');

    await page.getByTestId('board-card-BRD-W-2').dragTo(page.getByTestId('board-column-blocked'));
    await expect.poll(() => cardKeys(page, 'blocked')).toEqual(['BRD-W-2']);
    await expect(
      page.getByTestId('board-card-BRD-W-2').locator('.ui-badge', { hasText: 'Blocked' }),
    ).toBeVisible();
  });

  await test.step('the board persists after a reload', async () => {
    await page.reload();
    await expect.poll(() => cardKeys(page, 'todo')).toEqual(['BRD-W-3']);
    await expect.poll(() => cardKeys(page, 'blocked')).toEqual(['BRD-W-2']);
    await expect.poll(() => cardKeys(page, 'done')).toEqual(['BRD-W-1']);
  });

  await test.step('filters and swimlanes narrow and group the board', async () => {
    await page.getByLabel('Search the board').fill('gift');
    await expect(page.getByTestId('board-shown')).toHaveText('1 of 3 cards shown');
    await expect.poll(() => cardKeys(page, 'todo')).toEqual(['BRD-W-3']);
    await page.getByLabel('Search the board').fill('');
    await expect(page.getByTestId('board-shown')).toHaveText('3 of 3 cards shown');

    await page.getByLabel('Swimlanes').selectOption('assignee');
    await expect(page.getByRole('region', { name: 'Swimlane Unassigned' })).toBeVisible();

    await page.getByRole('link', { name: 'BRD-W-3 Gift cards' }).click();
    await expect(page).toHaveURL(/\/work-items\//);
  });
});
