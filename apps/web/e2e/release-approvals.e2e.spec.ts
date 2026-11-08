import { expect, test } from '@playwright/test';

/**
 * Release approvals (S6-F4), everything local: a Release Manager approval
 * rule on a protected production environment refuses a deployment; the
 * pipeline shows the pending approval; a change request (with a comment)
 * is recorded and revoked, then the approval lets the deployment through.
 */
const unique = Date.now();
const owner = {
  email: `e2e-approvals-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Approvals Owner',
};

test('required approvals block a protected environment until given', async ({ page }) => {
  const reportToProd = async (identifier: string) => {
    await page.getByRole('link', { name: 'Deployments', exact: true }).click();
    await page.getByLabel('Deployment identifier').fill(identifier);
    await page.getByLabel('Target environment').selectOption({ label: 'prod (protected)' });
    await page.getByLabel('Deployment release').selectOption({ label: '1.0.0 · Approved launch' });
    await page.getByRole('button', { name: 'Report deployment' }).click();
  };

  await test.step('the owner sets up a release, prod and a Release Manager approval rule', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Approvals ${unique}`);
    await page.getByLabel('Slug').fill(`approvals-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Approvals');
    await page.getByLabel('Key').fill('APR');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'APR', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByLabel('Release name').fill('Approved launch');
    await page.getByLabel('Version').fill('1.0.0');
    await page.getByRole('button', { name: 'Create release' }).click();
    await expect(page.getByRole('link', { name: 'Approved launch' })).toBeVisible();
    await page.getByRole('link', { name: 'Environments', exact: true }).click();
    await page.getByLabel('Environment name').fill('prod');
    await page.getByLabel('Environment kind').selectOption('production');
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(page.getByRole('heading', { name: 'Environment prod' })).toBeVisible();
    await page.getByRole('link', { name: 'Approval rules', exact: true }).click();
    await expect(page.getByText('No approval rule yet.')).toBeVisible();
    await page.getByLabel('Approval type').selectOption('release_manager');
    await page.getByLabel('Approval environment').selectOption({ label: 'prod' });
    await page.getByLabel('The release creator may approve').check();
    await page.getByRole('button', { name: 'Add approval rule' }).click();
    await expect(page.getByTestId('approval-rule-release_manager')).toContainText('prod');
  });

  await test.step('the deployment is refused and the pipeline shows the pending approval', async () => {
    await reportToProd('d-1');
    await expect(page.getByRole('alert')).toContainText('Release approvals for prod are pending');
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByRole('link', { name: 'Approved launch' }).click();
    await page.getByRole('link', { name: 'Release pipeline →' }).click();
    await expect(page.getByTestId('stage-approvals-prod')).toHaveText('pending');
    await expect(page.getByTestId('stage-status-prod')).toHaveText('blocked');
    await page.getByLabel('Approvals for environment').selectOption({ label: 'prod' });
    await expect(page.getByTestId('approval-release_manager')).toContainText('0/1');
  });

  await test.step('a change request needs a comment, shows in history and can be revoked', async () => {
    await page.getByLabel('Approve as').selectOption('release_manager');
    await page.getByLabel('Approval action').selectOption('request_changes');
    await page.getByLabel('Decision comment').fill('Smoke tests are missing');
    await page.getByRole('button', { name: 'Record decision' }).click();
    await expect(page.getByTestId('approvals-state')).toHaveText('changes requested');
    await expect(page.getByRole('list', { name: 'Approval history' })).toContainText(
      'Smoke tests are missing',
    );
    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByTestId('approvals-state')).toHaveText('pending');
    await expect(page.getByRole('list', { name: 'Approval history' })).toContainText('revoked by');
  });

  await test.step('the approval completes the workflow and the deployment goes through', async () => {
    await page.getByLabel('Approval action').selectOption('approve');
    await page.getByRole('button', { name: 'Record decision' }).click();
    await expect(page.getByTestId('approvals-state')).toHaveText('approved');
    await expect(page.getByTestId('stage-approvals-prod')).toHaveText('approved');
    await reportToProd('d-2');
    await expect(page.getByRole('heading', { name: 'Deployment d-2' })).toBeVisible();
  });
});
