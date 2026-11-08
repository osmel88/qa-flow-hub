import { expect, test } from '@playwright/test';

/**
 * Release pipeline (S6-F2), everything local: a release with a passed build
 * and two environments; deploying to dev makes dev deployed and staging
 * ready; a failed staging deployment fails the pipeline; filters and
 * navigation to the deployment behind a stage.
 */
const unique = Date.now();
const owner = {
  email: `e2e-pipeline-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Pipeline Owner',
};

test('a release pipeline follows deployments stage by stage', async ({ page }) => {
  const deployTo = async (identifier: string, environment: string, outcome: string) => {
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await page.getByLabel('Deployment identifier').fill(identifier);
    await page.getByLabel('Target environment').selectOption({ label: environment });
    await page.getByLabel('Deployed build').selectOption({ label: 'ci-1 · passed' });
    await page.getByLabel('Deployment release').selectOption({ label: '1.0.0 · Pipeline launch' });
    await page.getByRole('button', { name: 'Report deployment' }).click();
    await expect(page.getByRole('heading', { name: `Deployment ${identifier}` })).toBeVisible();
    await page.getByRole('button', { name: 'Mark deploying' }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText('deploying');
    await page.getByRole('button', { name: `Mark ${outcome}` }).click();
    await expect(page.getByTestId('deployment-status')).toHaveText(outcome);
  };
  const openPipeline = async () => {
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByRole('link', { name: 'Pipeline launch' }).click();
    await page.getByRole('link', { name: 'Release pipeline →' }).click();
    await expect(
      page.getByRole('heading', { name: 'Pipeline · Pipeline launch 1.0.0' }),
    ).toBeVisible();
  };

  await test.step('the owner sets up a release, a passed build and two environments', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Pipes ${unique}`);
    await page.getByLabel('Slug').fill(`pipes-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Pipes');
    await page.getByLabel('Key').fill('PIP');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'PIP', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByLabel('Release name').fill('Pipeline launch');
    await page.getByLabel('Version').fill('1.0.0');
    await page.getByRole('button', { name: 'Create release' }).click();
    await expect(page.getByRole('link', { name: 'Pipeline launch' })).toBeVisible();
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await page.getByLabel('Build identifier').fill('ci-1');
    await page.getByLabel('Initial status').selectOption('passed');
    await page.getByLabel('Build release').selectOption({ label: '1.0.0 · Pipeline launch' });
    await page.getByRole('button', { name: 'Report build' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('passed');
    for (const [name, kind] of [
      ['dev', 'development'],
      ['staging', 'staging'],
    ] as const) {
      await page.getByRole('link', { name: 'Environments', exact: true }).click();
      await page.getByLabel('Environment name').fill(name);
      await page.getByLabel('Environment kind').selectOption(kind);
      await page.getByRole('button', { name: 'Add environment' }).click();
      await expect(page.getByRole('heading', { name: `Environment ${name}` })).toBeVisible();
    }
  });

  await test.step('before any deployment the first stage is ready', async () => {
    await openPipeline();
    await expect(page.getByTestId('pipeline-status')).toHaveText('not started');
    await expect(page.getByTestId('stage-status-dev')).toHaveText('ready');
    await expect(page.getByTestId('stage-status-staging')).toHaveText('pending');
  });

  await test.step('deploying to dev moves the pipeline forward', async () => {
    await deployTo('d-dev', 'dev', 'succeeded');
    await openPipeline();
    await expect(page.getByTestId('pipeline-status')).toHaveText('in progress');
    await expect(page.getByTestId('pipeline-progress')).toHaveText('1/2 stages deployed (50%)');
    await expect(page.getByTestId('stage-status-dev')).toHaveText('deployed');
    await expect(page.getByTestId('stage-status-staging')).toHaveText('ready');
    await page.getByTestId('stage-dev').getByRole('link', { name: 'd-dev' }).click();
    await expect(page.getByRole('heading', { name: 'Deployment d-dev' })).toBeVisible();
  });

  await test.step('a failed staging deployment fails the pipeline; filters narrow stages', async () => {
    await deployTo('d-stg', 'staging', 'failed');
    await openPipeline();
    await expect(page.getByTestId('pipeline-status')).toHaveText('failed');
    await expect(page.getByTestId('stage-status-staging')).toHaveText('failed');
    await page.getByLabel('Stage status').selectOption('deployed');
    await expect(page.getByTestId('stage-dev')).toBeVisible();
    await expect(page.getByTestId('stage-staging')).toHaveCount(0);
    await page.getByLabel('Stage status').selectOption('');
    await page.getByLabel('Stage environment').selectOption({ label: 'staging' });
    await expect(page.getByTestId('stage-dev')).toHaveCount(0);
    await expect(page.getByTestId('stage-staging')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('stage-status-staging')).toHaveText('failed');
  });
});
