import { expect, test } from '@playwright/test';

/**
 * Builds (S5-F4), everything local: the owner reports a queued build of a
 * story, moves it to running and passed, sees that a passed build offers no
 * further transition, finds `build passed` in the story's development status
 * and the success rate in the metrics, filters, and reloads.
 */
const unique = Date.now();
const owner = {
  email: `e2e-build-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Build Owner',
};

test('a local build moves through its lifecycle and drives development status', async ({
  page,
}) => {
  await test.step('the owner creates a project with a story', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Builds ${unique}`);
    await page.getByLabel('Slug').fill(`builds-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Builds');
    await page.getByLabel('Key').fill('BLD');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'BLD', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Work items' }).click();
    await page.getByLabel('Title').fill('Card payment form');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Card payment form' })).toBeVisible();
  });

  await test.step('a queued build of the story is reported', async () => {
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await expect(page.getByText('No builds match.')).toBeVisible();
    await page.getByLabel('Build identifier').fill('ci-101');
    await page.getByLabel('Build branch').fill('feature/cards');
    await page.getByLabel('Built work item').selectOption({ label: 'BLD-W-1 · Card payment form' });
    await page.getByRole('button', { name: 'Report build' }).click();
    await expect(page.getByRole('heading', { name: 'Build ci-101' })).toBeVisible();
    await expect(page.getByTestId('build-status')).toHaveText('queued');
  });

  await test.step('it runs and passes, and a passed build cannot move again', async () => {
    await page.getByRole('button', { name: 'Mark running' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('running');
    await expect(page.getByRole('button', { name: 'Mark queued' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Mark passed' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('passed');
    await expect(page.getByRole('button', { name: /^Mark / })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('build-status')).toHaveText('passed');
  });

  await test.step('the story shows build passed and the metrics count the build', async () => {
    await page.getByRole('link', { name: 'BLD-W-1 · Card payment form' }).click();
    await expect(page.getByTestId('development-status')).toHaveText('build passed');
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await expect(page.getByTestId('build-metric-total')).toHaveText('1');
    await expect(page.getByTestId('build-metric-success')).toHaveText('100%');
    await expect(page.getByTestId('build-ci-101')).toContainText('passed');
    await page.getByLabel('Status filter').selectOption('failed');
    await expect(page.getByText('No builds match.')).toBeVisible();
    await page.getByLabel('Status filter').selectOption('passed');
    await expect(page.getByTestId('build-ci-101')).toBeVisible();
  });
});
