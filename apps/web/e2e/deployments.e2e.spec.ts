import { expect, test } from '@playwright/test';

/**
 * Deployments (S5-F5), everything local: the owner adds an environment,
 * reports a passed build and a deployment of it for a story, moves the
 * deployment to succeeded (story `deployed`), rolls it back once (story no
 * longer deployed, the original cannot roll back again), filters and reloads.
 */
const unique = Date.now();
const owner = {
  email: `e2e-deploy-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Deploy Owner',
};

test('a local deployment succeeds, drives development status and rolls back once', async ({
  page,
}) => {
  await test.step('the owner creates a project with a story and a passed build', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Deploys ${unique}`);
    await page.getByLabel('Slug').fill(`deploys-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Deploys');
    await page.getByLabel('Key').fill('DEP');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'DEP', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Work items' }).click();
    await page.getByLabel('Title').fill('Checkout flow');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Checkout flow' })).toBeVisible();
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await page.getByLabel('Build identifier').fill('ci-7');
    await page.getByLabel('Initial status').selectOption('passed');
    await page.getByRole('button', { name: 'Report build' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('passed');
  });

  await test.step('an environment is added and a deployment reported', async () => {
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await page.getByLabel('Environment name').fill('staging');
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('heading', { name: 'Environment staging' })).toBeVisible();
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await expect(page.getByText('No deployments match.')).toBeVisible();
    await expect(page.getByTestId('environment-staging')).toContainText('nothing deployed');
    await page.getByLabel('Deployment identifier').fill('dep-1');
    await page.getByLabel('Target environment').selectOption({ label: 'staging' });
    await page.getByLabel('Deployed build').selectOption({ label: 'ci-7 · passed' });
    await page.getByLabel('Deployed work item').selectOption({ label: 'DEP-W-1 · Checkout flow' });
    await page.getByRole('button', { name: 'Report deployment' }).click();
    await expect(page.getByRole('heading', { name: 'Deployment dep-1' })).toBeVisible();
    await expect(page.getByTestId('deployment-status')).toHaveText('pending');
  });

  await test.step('it deploys and succeeds, and the story is deployed', async () => {
    await page.getByRole('button', { name: 'Mark deploying' }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('deploying');
    await page.getByRole('button', { name: 'Mark succeeded' }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('succeeded');
    await expect(page.getByRole('button', { name: /^Mark / })).toHaveCount(0);
    await page.getByRole('link', { name: 'DEP-W-1 · Checkout flow' }).click();
    await expect(page.getByTestId('development-status')).toHaveText('deployed');
    await page
      .getByRole('table', { name: 'Related deployments' })
      .getByRole('link', { name: 'dep-1' })
      .click();
  });

  await test.step('a rollback replaces it once and the story is no longer deployed', async () => {
    await page.getByLabel('Rollback reason').fill('Checkout is broken in staging');
    await page.getByRole('button', { name: 'Roll back' }).click();
    await expect(page.getByRole('heading', { name: 'Deployment dep-1-rollback' })).toBeVisible();
    await expect(page.getByTestId('deployment-rollback')).toContainText('Rolled back from dep-1');
    await page.getByRole('link', { name: 'dep-1', exact: true }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('rolled back');
    await expect(page.getByRole('button', { name: 'Roll back' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('deployment-status')).toHaveText('rolled back');
    await page.getByRole('link', { name: 'DEP-W-1 · Checkout flow' }).click();
    await expect(page.getByTestId('development-status')).not.toHaveText('deployed');
  });

  await test.step('metrics and filters count the deployments', async () => {
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await expect(page.getByTestId('deployment-metric-total')).toHaveText('2');
    await expect(page.getByTestId('deployment-metric-rollbacks')).toHaveText('1');
    await expect(page.getByTestId('environment-staging')).toContainText('dep-1-rollback');
    await page.getByLabel('Status filter').selectOption('rolled_back');
    await expect(page.getByTestId('deployment-dep-1')).toBeVisible();
    await expect(page.getByTestId('deployment-dep-1-rollback')).toHaveCount(0);
    await page.getByLabel('Status filter').selectOption('failed');
    await expect(page.getByText('No deployments match.')).toBeVisible();
  });
});
