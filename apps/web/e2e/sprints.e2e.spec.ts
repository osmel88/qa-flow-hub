import { expect, test } from '@playwright/test';

/**
 * Sprints (S4-F5): the owner plans two estimated items into a sprint, starts
 * it, finishes one, completes the sprint carrying the other back to the
 * backlog, and the project velocity reflects the completed estimate.
 */
const unique = Date.now();
const owner = {
  email: `e2e-sprints-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Sprint Planner',
};

test('sprint planning, start, completion with carry-over and velocity', async ({ page }) => {
  await test.step('the owner sets up a project with two estimated stories', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Sprinter ${unique}`);
    await page.getByLabel('Slug').fill(`sprinter-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Sprinter');
    await page.getByLabel('Key').fill('SPR');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'SPR', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    for (const title of ['Saved cards', 'Coupon codes']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Add work item' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }

    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('Select SPR-W-1').check();
    await page.getByLabel('Select SPR-W-2').check();
    await page.getByLabel('Set estimate').fill('3');
    await page.getByRole('button', { name: 'Apply to 2 items' }).click();
    await expect(page.getByTestId('backlog-totals')).toHaveText(
      '2 items · 6 estimated · 0 unestimated',
    );
  });

  await test.step('a sprint is created and both stories are planned into it', async () => {
    await page.getByRole('link', { name: 'Sprints', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sprints', exact: true })).toBeVisible();
    await page.getByLabel('Sprint name').fill('Sprint 1');
    await page.getByLabel('Goal').fill('Ship card payments');
    await page.getByLabel('Capacity (points)').fill('10');
    await page.getByRole('button', { name: 'Create sprint' }).click();
    await page.getByRole('link', { name: 'Sprint 1' }).click();
    await expect(page.getByRole('heading', { name: 'Sprint 1' })).toBeVisible();

    await page.getByLabel('Plan SPR-W-1').check();
    await page.getByLabel('Plan SPR-W-2').check();
    await page.getByRole('button', { name: 'Add to sprint' }).click();
    const sprintBacklog = page.getByRole('table', { name: 'Sprint backlog' });
    await expect(sprintBacklog.getByRole('link', { name: 'SPR-W-1' })).toBeVisible();
    await expect(sprintBacklog.getByRole('link', { name: 'SPR-W-2' })).toBeVisible();
    await expect(page.getByTestId('committed')).toHaveText('6');

    await page.getByRole('button', { name: 'Start sprint' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sprint started.' })).toBeVisible();
    await expect(page.getByText(/^active /)).toBeVisible();
  });

  await test.step('finishing one story moves the sprint progress', async () => {
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('Sprint filter').selectOption({ label: 'Sprint 1 (active)' });
    await page.getByLabel('Select SPR-W-1').check();
    await page.getByLabel('Set status').selectOption('done');
    await page.getByRole('button', { name: /Apply to 1 item/ }).click();
    await expect(page.getByTestId('backlog-row-SPR-W-1')).toHaveCount(0);

    await page.getByRole('link', { name: 'Sprints', exact: true }).click();
    await page.getByRole('link', { name: 'Sprint 1' }).click();
    await expect(page.getByTestId('completed')).toHaveText('3');
    await expect(page.getByTestId('progress')).toHaveText('50%');
  });

  await test.step('completing carries the open story back to the backlog', async () => {
    await page.getByRole('button', { name: 'Complete sprint' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'carried over' })).toHaveText(
      'Sprint completed; 1 unfinished item(s) carried over.',
    );
    await expect(page.getByRole('button', { name: 'Start sprint' })).toHaveCount(0);

    await page.getByRole('link', { name: 'All sprints' }).click();
    await expect(page.getByTestId('velocity')).toHaveText('3');

    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.getByLabel('Sprint filter').selectOption('none');
    await expect(page.getByTestId('backlog-row-SPR-W-2')).toBeVisible();
  });
});
