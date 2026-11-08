import { expect, test } from '@playwright/test';

/**
 * Quality gates (S6-F3), everything local: a required gate on a protected
 * production environment blocks a deployment of a release whose build
 * failed; the pipeline shows why and links to the build; the owner
 * overrides with a reason and the deployment goes through.
 */
const unique = Date.now();
const owner = {
  email: `e2e-gates-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Gates Owner',
};

test('a required gate blocks a protected environment until overridden', async ({ page }) => {
  const reportToProd = async (identifier: string) => {
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await page.getByLabel('Deployment identifier').fill(identifier);
    await page.getByLabel('Target environment').selectOption({ label: 'prod (protected)' });
    await page.getByLabel('Deployment release').selectOption({ label: '1.0.0 · Gated launch' });
    await page.getByRole('button', { name: 'Report deployment' }).click();
  };
  const openPipeline = async () => {
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByRole('link', { name: 'Gated launch' }).click();
    await page.getByRole('link', { name: 'Release pipeline →' }).click();
  };

  await test.step('the owner sets up a release, a failed build, prod and a gate', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Gates ${unique}`);
    await page.getByLabel('Slug').fill(`gates-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Gates');
    await page.getByLabel('Key').fill('GAT');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'GAT', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByLabel('Release name').fill('Gated launch');
    await page.getByLabel('Version').fill('1.0.0');
    await page.getByRole('button', { name: 'Create release' }).click();
    await expect(page.getByRole('link', { name: 'Gated launch' })).toBeVisible();
    await page.getByRole('link', { name: 'Builds', exact: true }).click();
    await page.getByLabel('Build identifier').fill('ci-1');
    await page.getByLabel('Initial status').selectOption('failed');
    await page.getByLabel('Build release').selectOption({ label: '1.0.0 · Gated launch' });
    await page.getByRole('button', { name: 'Report build' }).click();
    await expect(page.getByTestId('build-status')).toHaveText('failed');
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await page.getByLabel('Environment name').fill('prod');
    await page.getByLabel('Environment kind').selectOption('production');
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('heading', { name: 'Environment prod' })).toBeVisible();
    await page.getByRole('link', { name: 'Quality gates', exact: true }).click();
    await expect(page.getByText('No quality gate yet.')).toBeVisible();
    await page.getByLabel('Gate name').fill('Release ready');
    await page.getByLabel('Gate environment').selectOption({ label: 'prod' });
    await page.getByLabel('A build is required and must pass').check();
    await page.getByRole('button', { name: 'Add quality gate' }).click();
    await expect(page.getByTestId('quality-gate-Release ready')).toContainText('prod');
  });

  await test.step('the deployment is refused and the pipeline says why', async () => {
    await reportToProd('d-1');
    await expect(page.getByRole('alert')).toContainText('Required quality gates of prod');
    await openPipeline();
    await expect(page.getByTestId('stage-gates-prod')).toHaveText('failed');
    await expect(page.getByTestId('stage-status-prod')).toHaveText('blocked');
    await page.getByLabel('Gates for environment').selectOption({ label: 'prod' });
    await expect(page.getByTestId('gates-required')).toHaveText('failed');
    const rule = page.getByTestId('rule-Release ready-build_must_pass');
    await expect(rule).toContainText('Latest build ci-1 failed');
    await expect(rule.getByRole('link', { name: 'ci-1' })).toBeVisible();
  });

  await test.step('an override with a reason lets the deployment through', async () => {
    await page.getByLabel('Override reason').fill('Hotfix approved by the release board');
    await page.getByRole('button', { name: 'Override gates' }).click();
    await expect(page.getByTestId('gates-override')).toContainText('Hotfix approved');
    await expect(page.getByTestId('stage-gates-prod')).toContainText('failed');
    await reportToProd('d-2');
    await expect(page.getByRole('heading', { name: 'Deployment d-2' })).toBeVisible();
  });
});
