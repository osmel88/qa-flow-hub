import { expect, test } from '@playwright/test';

/**
 * Environment rollback (S6-F5), everything local: two succeeded deployments
 * in staging; the owner rolls the environment back to the first one with a
 * reason; the history says "Rolled back from dep-2 to dep-1" and links the
 * original, the rollback and the target.
 */
const unique = Date.now();
const owner = {
  email: `e2e-rollback-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Rollback Owner',
};

test('an environment is rolled back to an earlier deployment with a reason', async ({ page }) => {
  const shipToStaging = async (identifier: string, buildIndex: number) => {
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await page.getByLabel('Deployment identifier').fill(identifier);
    await page.getByLabel('Target environment').selectOption({ label: 'staging' });
    await page.getByLabel('Deployed build').selectOption({ index: buildIndex });
    await page.getByRole('button', { name: 'Report deployment' }).click();
    await expect(page.getByRole('heading', { name: `Deployment ${identifier}` })).toBeVisible();
    await page.getByRole('button', { name: 'Mark deploying' }).click();
    await page.getByRole('button', { name: 'Mark succeeded' }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('succeeded');
  };

  await test.step('the owner ships two deployments to staging', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Rollback ${unique}`);
    await page.getByLabel('Slug').fill(`rollback-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Rollbacks');
    await page.getByLabel('Key').fill('RBK');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'RBK', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await page.getByLabel('Build identifier').fill('ci-1');
    await page.getByLabel('Initial status').selectOption('passed');
    await page.getByRole('button', { name: 'Report build' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('passed');
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await page.getByLabel('Build identifier').fill('ci-2');
    await page.getByLabel('Initial status').selectOption('passed');
    await page.getByRole('button', { name: 'Report build' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('passed');
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await page.getByLabel('Environment name').fill('staging');
    await page.getByLabel('Environment kind').selectOption('staging');
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('heading', { name: 'Environment staging' })).toBeVisible();
    await shipToStaging('dep-1', 1);
    await shipToStaging('dep-2', 2);
  });

  await test.step('the environment is rolled back to dep-1 and the history says so', async () => {
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await page.getByRole('link', { name: 'staging' }).first().click();
    await expect(page.getByTestId('environment-current')).toContainText('dep-2');
    await expect(page.getByText('No rollback yet.')).toBeVisible();
    await page.getByLabel('Rollback target').selectOption({ index: 1 });
    await page.getByLabel('Reason for the rollback').fill('Checkout errors after dep-2');
    await page.getByRole('button', { name: 'Roll back environment' }).click();
    const entry = page.getByTestId('rollback-dep-2-rollback');
    await expect(entry).toContainText('Rolled back from dep-2 to dep-1');
    await expect(entry).toContainText('Checkout errors after dep-2');
    await expect(page.getByTestId('environment-current')).toContainText('dep-2-rollback');
  });

  await test.step('the rollback links to the original and the target', async () => {
    await page
      .getByTestId('rollback-dep-2-rollback')
      .getByRole('link', { name: 'dep-2-rollback' })
      .click();
    await expect(page.getByTestId('deployment-rollback')).toContainText(
      'Rolled back from dep-2 to dep-1',
    );
    await page
      .getByTestId('deployment-rollback')
      .getByRole('link', { name: 'dep-2', exact: true })
      .click();
    await expect(page.getByTestId('deployment-status')).toHaveText('rolled back');
  });
});
