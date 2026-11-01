import { expect, test } from '@playwright/test';

/**
 * Development links (S5-F1): with everything local, the owner records a pull
 * request linked to a story and an unlinked commit, follows the badge to the
 * story, links the commit there, unlinks the pull request, reloads, and goes
 * back to the consolidated activity filtered by the story.
 */
const unique = Date.now();
const owner = {
  email: `e2e-dev-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Dev Owner',
};

test('development links between work items and local development activity', async ({ page }) => {
  await test.step('the owner creates a project with a story', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Dev ${unique}`);
    await page.getByLabel('Slug').fill(`dev-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Dev');
    await page.getByLabel('Key').fill('DEV');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'DEV', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Work items' }).click();
    await page.getByLabel('Title').fill('Card payment form');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Card payment form' })).toBeVisible();
  });

  const activity = page.getByRole('table', { name: 'Development activity' });

  await test.step('a pull request linked to the story and a commit are recorded', async () => {
    await page.getByRole('link', { name: 'Development', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Development', exact: true })).toBeVisible();
    await expect(page.getByText('No development activity matches.')).toBeVisible();
    await page.getByLabel('Pull request number').fill('12');
    await page.getByLabel('Title').fill('Card form');
    await page.getByLabel('Artifact status').selectOption('open');
    await page.getByLabel('Link to work item').selectOption({ label: 'DEV-W-1 Card payment form' });
    await page.getByRole('button', { name: 'Record activity' }).click();
    await expect(page.getByRole('status')).toContainText('#12');
    await expect(activity.getByRole('link', { name: 'DEV-W-1' })).toBeVisible();

    await page.getByLabel('Artifact kind').selectOption('commit');
    await page.getByLabel('Commit SHA').fill('ABCDEF1234567');
    await page.getByLabel('Link to work item').selectOption({ label: 'No work item' });
    await page.getByRole('button', { name: 'Record activity' }).click();
    await expect(activity.getByText('abcdef1')).toBeVisible();
    await expect(activity.getByText('Not linked')).toBeVisible();
  });

  const section = page.getByRole('region', { name: 'Development' });

  await test.step('the story shows its activity, links the commit and unlinks the PR', async () => {
    await activity.getByRole('link', { name: 'DEV-W-1' }).click();
    await expect(section.getByRole('list').getByText('#12')).toBeVisible();
    await expect(section.getByTestId('development-status')).toHaveText('pr open');
    await expect(section.getByTestId('development-evidence')).toContainText('#12');
    await page.getByLabel('Link development artifact').selectOption({ label: 'commit abcdef1' });
    await page.getByRole('button', { name: 'Link artifact' }).click();
    await expect(section.getByRole('list').getByText('abcdef1')).toBeVisible();
    await section.getByRole('button', { name: 'Unlink pull_request #12' }).click();
    await expect(section.getByRole('list').getByText('#12')).toHaveCount(0);
    await expect(section.getByTestId('development-status')).toHaveText('commits');
  });

  await test.step('the links persist after a reload', async () => {
    await page.reload();
    await expect(section.getByRole('list').getByText('abcdef1')).toBeVisible();
    await expect(section.getByRole('list').getByText('#12')).toHaveCount(0);
  });

  await test.step('the backlog shows the badge and filters by development status', async () => {
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await expect(page.getByTestId('development-status-DEV-W-1')).toHaveText('commits');
    await page.getByLabel('Development filter').selectOption('deployed');
    await expect(page.getByTestId('backlog-row-DEV-W-1')).toHaveCount(0);
    await page.getByLabel('Development filter').selectOption('commits');
    await expect(page.getByTestId('backlog-row-DEV-W-1')).toBeVisible();
    await page
      .getByTestId('backlog-row-DEV-W-1')
      .getByRole('link', { name: 'Card payment form' })
      .click();
  });

  await test.step('the consolidated view filters by work item and kind', async () => {
    await section.getByRole('link', { name: 'Record or browse development activity' }).click();
    await expect(activity.getByText('abcdef1')).toBeVisible();
    await expect(activity.getByText('#12')).toHaveCount(0);
    await page.getByLabel('Filter by work item').selectOption('');
    await page.getByLabel('Filter by kind').selectOption('pull_request');
    await expect(activity.getByText('#12')).toBeVisible();
    await expect(activity.getByText('abcdef1')).toHaveCount(0);
    await expect(activity.getByText('Not linked')).toBeVisible();
  });
});
