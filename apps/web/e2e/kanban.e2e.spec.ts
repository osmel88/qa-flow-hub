import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Kanban board (S4-F7): with no sprint at all, the owner moves cards with the
 * keyboard controls and drag & drop, sets a WIP limit that refuses a move,
 * reloads to check the board persisted, then filters and groups it.
 */
const unique = Date.now();
const owner = {
  email: `e2e-kanban-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Kanban Owner',
};

const cardKeys = (page: Page, column: string) =>
  page
    .getByTestId(`kanban-column-${column}`)
    .locator('[data-testid^="kanban-card-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-testid')?.replace('kanban-card-', '')),
    );

test('kanban board without sprints: moves, WIP limit, persistence, filters', async ({ page }) => {
  await test.step('the owner creates a project with three work items', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Flow ${unique}`);
    await page.getByLabel('Slug').fill(`flow-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Flow');
    await page.getByLabel('Key').fill('FLW');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'FLW', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    for (const title of ['Saved cards', 'Coupon codes', 'Gift cards']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Add work item' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }
  });

  await test.step('cards move with the keyboard controls and with drag & drop', async () => {
    await page.getByRole('link', { name: 'Kanban', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Kanban', exact: true })).toBeVisible();
    await expect.poll(() => cardKeys(page, 'backlog')).toEqual(['FLW-W-1', 'FLW-W-2', 'FLW-W-3']);

    await page.getByRole('button', { name: 'Move FLW-W-3 up' }).click();
    await expect.poll(() => cardKeys(page, 'backlog')).toEqual(['FLW-W-1', 'FLW-W-3', 'FLW-W-2']);

    await page.getByLabel('Move FLW-W-1 to column').selectOption('done');
    await expect.poll(() => cardKeys(page, 'done')).toEqual(['FLW-W-1']);
    await expect(page.getByTestId('kanban-throughput')).toHaveText('1');

    await page
      .getByTestId('kanban-card-FLW-W-2')
      .dragTo(page.getByTestId('kanban-column-in_progress'));
    await expect.poll(() => cardKeys(page, 'in_progress')).toEqual(['FLW-W-2']);
    await expect(page.getByTestId('kanban-wip')).toHaveText('1');
  });

  await test.step('a WIP limit refuses a move into a full column', async () => {
    await page.getByLabel('WIP limit In progress').fill('1');
    await page.getByRole('button', { name: 'Save WIP limits' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'WIP limits saved.' })).toBeVisible();
    await expect(page.getByTestId('kanban-count-in_progress')).toContainText('1/1');
    await page.getByLabel('Move FLW-W-3 to column').selectOption('in_progress');
    await expect(page.getByRole('alert')).toContainText('WIP limit (1/1)');
    await expect.poll(() => cardKeys(page, 'backlog')).toEqual(['FLW-W-3']);
  });

  await test.step('the board persists after a reload', async () => {
    await page.reload();
    await expect.poll(() => cardKeys(page, 'backlog')).toEqual(['FLW-W-3']);
    await expect.poll(() => cardKeys(page, 'in_progress')).toEqual(['FLW-W-2']);
    await expect.poll(() => cardKeys(page, 'done')).toEqual(['FLW-W-1']);
    await expect(page.getByTestId('kanban-count-in_progress')).toContainText('1/1');
  });

  await test.step('filters and swimlanes narrow and group the board', async () => {
    await page.getByLabel('Search the Kanban board').fill('gift');
    await expect(page.getByTestId('kanban-shown')).toHaveText('1 of 3 cards shown');
    await page.getByLabel('Search the Kanban board').fill('');
    await expect(page.getByTestId('kanban-shown')).toHaveText('3 of 3 cards shown');

    await page.getByLabel('Swimlanes').selectOption('assignee');
    await expect(page.getByRole('region', { name: 'Swimlane Unassigned' })).toBeVisible();

    await page.getByRole('link', { name: 'FLW-W-3 Gift cards' }).click();
    await expect(page).toHaveURL(/\/work-items\//);
  });
});
