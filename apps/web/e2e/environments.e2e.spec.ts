import { expect, test } from '@playwright/test';

/**
 * Environments (S6-F1), everything local: the owner adds a production
 * environment (protected by default) and a scratch one, edits it, deploys to
 * it, sees health and what runs there, cannot delete it because of its
 * history, archives it (no longer offered for deployments), reloads and
 * restores it; the scratch one, never deployed to, is deleted.
 */
const unique = Date.now();
const owner = {
  email: `e2e-env-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Env Owner',
};

test('environments are created, edited, deployed to, archived and restored', async ({ page }) => {
  await test.step('the owner creates a project', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Envs ${unique}`);
    await page.getByLabel('Slug').fill(`envs-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Envs');
    await page.getByLabel('Key').fill('ENV');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'ENV', exact: true })).toBeVisible();
  });

  await test.step('a scratch environment without history can be deleted', async () => {
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await expect(page.getByText('No environments match.')).toBeVisible();
    await page.getByLabel('Environment name').fill('scratch');
    await page.getByLabel('Environment kind').selectOption('custom');
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('heading', { name: 'Environment scratch' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete environment' }).click();
    await expect(page.getByText('No environments match.')).toBeVisible();
  });

  await test.step('production starts protected and can be edited', async () => {
    await page.getByLabel('Environment name').fill('prod');
    await page.getByLabel('Environment kind').selectOption('production');
    await page.getByLabel('Environment URL').fill('https://prod.example.test');
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('heading', { name: 'Environment prod' })).toBeVisible();
    await expect(page.getByTestId('environment-health-prod')).toContainText('idle');
    await expect(page.getByTestId('environment-health-prod')).toContainText('protected');
    await page.getByLabel('Description').fill('Customer facing');
    await page.getByRole('button', { name: 'Save environment' }).click();
    await expect(page.getByText('Customer facing')).toBeVisible();
  });

  await test.step('a deployment to it makes it healthy and shows what runs there', async () => {
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await page.getByLabel('Deployment identifier').fill('dep-prod');
    await page.getByLabel('Target environment').selectOption({ label: 'prod (protected)' });
    await page.getByRole('button', { name: 'Report deployment' }).click();
    await expect(page.getByRole('heading', { name: 'Deployment dep-prod' })).toBeVisible();
    await page.getByRole('button', { name: 'Mark deploying' }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('deploying');
    await page.getByRole('button', { name: 'Mark succeeded' }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('succeeded');
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await expect(page.getByTestId('environment-row-prod')).toContainText('dep-prod');
    await expect(page.getByTestId('environment-health-prod')).toContainText('healthy');
    await page.getByRole('link', { name: 'prod', exact: true }).click();
    await expect(page.getByTestId('environment-current')).toContainText('dep-prod');
    await expect(
      page.getByRole('table', { name: 'Related deployments' }).getByRole('link', {
        name: 'dep-prod',
      }),
    ).toBeVisible();
  });

  await test.step('with history it is archived, not deleted, and later restored', async () => {
    await expect(page.getByRole('button', { name: 'Delete environment' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Archive environment' }).click();
    await expect(page.getByTestId('environment-status')).toHaveText('archived');
    await page.reload();
    await expect(page.getByTestId('environment-status')).toHaveText('archived');
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await expect(page.getByLabel('Target environment')).toHaveCount(0);
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await expect(page.getByText('No environments match.')).toBeVisible();
    await page.getByLabel('Environment status').selectOption('archived');
    await page.getByRole('link', { name: 'prod', exact: true }).click();
    await page.getByRole('button', { name: 'Restore environment' }).click();
    await expect(page.getByTestId('environment-status')).toHaveText('active');
    await expect(page.getByTestId('environment-health-prod')).toContainText('healthy');
  });
});
