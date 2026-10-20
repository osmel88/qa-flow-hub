import { expect, test } from '@playwright/test';

/**
 * Releases (S3-F4): the owner plans a release, starts it, creates a run in
 * it, filters the runs by release, sees the run on the release dashboard and
 * archives the release without losing the run.
 */
const unique = Date.now();
const owner = {
  email: `e2e-release-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Release Owner',
};

test('release lifecycle with runs filtered by release', async ({ page }) => {
  await test.step('the owner sets up an organization, a project and a case', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Release ${unique}`);
    await page.getByLabel('Slug').fill(`release-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Releases');
    await page.getByLabel('Key').fill('REL');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'REL', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('link', { name: 'Pay with a card' })).toBeVisible();
  });

  await test.step('a release is planned and started', async () => {
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByLabel('Release name').fill('Spring launch');
    await page.getByLabel('Version').fill('2.4.0');
    await page.getByLabel('Tag (optional)').fill('v2.4.0');
    await page.getByRole('button', { name: 'Create release' }).click();
    await page.getByRole('link', { name: 'Spring launch' }).click();
    await expect(page.getByRole('heading', { name: 'Spring launch · 2.4.0' })).toBeVisible();
    await page.getByRole('button', { name: 'Start release' }).click();
    await expect(page.getByRole('button', { name: 'Mark as released' })).toBeVisible();
  });

  await test.step('runs are created in and out of the release and filtered', async () => {
    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Name').fill('Release regression');
    await page
      .getByLabel('Release', { exact: true })
      .selectOption({ label: 'Spring launch (2.4.0)' });
    await page.getByRole('button', { name: 'Create run' }).click();
    await expect(page.getByRole('link', { name: 'Release regression' })).toBeVisible();

    await page.getByLabel('Name').fill('Nightly smoke');
    await page.getByRole('button', { name: 'Create run' }).click();
    await expect(page.getByRole('link', { name: 'Nightly smoke' })).toBeVisible();

    await page.getByLabel('Filter by release').selectOption({ label: 'Spring launch (2.4.0)' });
    await expect(page.getByRole('link', { name: 'Release regression' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nightly smoke' })).toHaveCount(0);
  });

  await test.step('the release dashboard shows the run and archiving keeps it', async () => {
    await page.getByRole('link', { name: 'Spring launch (2.4.0)' }).click();
    const runs = page.getByRole('region', { name: 'Runs' });
    await expect(runs.getByRole('link', { name: 'Release regression' })).toBeVisible();
    await page.getByRole('button', { name: 'Archive release' }).click();
    await expect(page.getByText('archived', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive release' })).toHaveCount(0);
    await expect(runs.getByRole('link', { name: 'Release regression' })).toBeVisible();

    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Filter by release').selectOption({ label: 'Spring launch (2.4.0)' });
    await expect(page.getByRole('link', { name: 'Release regression' })).toBeVisible();
    await expect(
      page.getByLabel('Release', { exact: true }).locator('option', { hasText: 'Spring launch' }),
    ).toHaveCount(0);
  });
});
