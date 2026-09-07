import { expect, test } from '@playwright/test';

/**
 * Settings → Integrations (S2-F1) and the Jira mock (S2-F2): an owner
 * configures Jira, sees the mock answer Test connection, connects, and pushes a
 * requirement and a defect to it; every action that cannot succeed yet says
 * which phase delivers it instead of pretending. The screen is checked against
 * a real API so the tenant header, the role gate and the secret-free response
 * shape are all exercised.
 */
const unique = Date.now();
const account = {
  email: `e2e-integrations-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Integration Owner',
};

test('an owner configures Jira and is told what is not available yet', async ({ page }) => {
  await test.step('register and create the organization', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();

    await page.getByLabel('Name').fill(`Integrations ${unique}`);
    await page.getByLabel('Slug').fill(`integrations-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('open the integrations screen', async () => {
    await page.getByRole('link', { name: 'Integrations' }).click();
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
    for (const provider of ['Jira', 'TestRail', 'GitHub']) {
      await expect(page.getByRole('heading', { name: provider, level: 2 })).toBeVisible();
    }
  });

  const jira = page.getByRole('region', { name: 'Jira' });
  const github = page.getByRole('region', { name: 'GitHub' });

  await test.step('save a mock Jira configuration', async () => {
    await expect(jira.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    await jira.getByLabel('Base URL').fill('https://jira.example.test');
    await jira.getByLabel('Configuration').fill('projectKey=WEB');
    await jira.getByRole('button', { name: 'Save' }).click();
    await expect(jira.getByRole('status')).toContainText('Configuration saved.');
    await expect(jira.locator('.ui-badge', { hasText: 'Mock' })).toBeVisible();
  });

  await test.step('a credential-like key is refused', async () => {
    await jira.getByLabel('Configuration').fill('apiToken=abc');
    await jira.getByRole('button', { name: 'Save' }).click();
    await expect(jira.getByRole('alert')).toContainText('Credentials cannot be stored');
    await jira.getByLabel('Configuration').fill('projectKey=WEB');
  });

  await test.step('test connection reaches the mock and records the attempt', async () => {
    await jira.getByRole('button', { name: 'Test connection' }).click();
    await expect(jira.getByRole('status')).toContainText('issues will be created in project WEB');
    await expect(jira.getByText('never')).toHaveCount(1);
  });

  await test.step('connect makes Jira connected, disconnect clears it', async () => {
    await jira.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(jira.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
    await expect(jira.locator('.ui-badge', { hasText: 'Enabled' })).toBeVisible();

    await jira.getByRole('button', { name: 'Disconnect' }).click();
    await expect(jira.locator('.ui-badge', { hasText: 'Disconnected' })).toBeVisible();
    await expect(jira.locator('.ui-badge', { hasText: 'Disabled' })).toBeVisible();

    await jira.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(jira.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
  });

  await test.step('GitHub is configurable but explains it needs S2-F4', async () => {
    await expect(github.getByText(/S2-F4/)).toBeVisible();
    await expect(github.getByLabel('Base URL')).toHaveCount(0);
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(github.getByRole('status')).toContainText('Configuration saved.');
    await github.getByRole('button', { name: 'Test connection' }).click();
    await expect(github.getByRole('status')).toContainText('S2-F4');
    await expect(github.locator('.ui-badge', { hasText: /^Connected$/ })).toHaveCount(0);
  });

  await test.step('create a project with a requirement and a defect', async () => {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Requirements' }).click();
    await expect(page.getByRole('heading', { name: 'New requirement' })).toBeVisible();
    await page.getByLabel('Title').fill('The user can pay by card');
    await page.getByRole('button', { name: 'Create requirement' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-R-1' })).toBeVisible();
  });

  await test.step('the requirement becomes a Jira mock issue, and re-sync keeps the key', async () => {
    const row = page.getByRole('row', { name: /WEB-R-1/ });
    await row.getByRole('button', { name: 'Sync to Jira' }).click();
    // WEB-1 is a seed issue of the mock, so the first one we create is WEB-2.
    const link = page.getByRole('link', { name: 'WEB-2' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://jira.example.test/browse/WEB-2');

    await row.getByRole('button', { name: 'Re-sync' }).click();
    await expect(page.getByRole('link', { name: 'WEB-2' })).toHaveCount(1);
  });

  await test.step('the defect becomes a Jira mock bug', async () => {
    await page.getByRole('link', { name: 'Defects' }).click();
    await expect(page.getByRole('heading', { name: 'Report a defect' })).toBeVisible();
    await page.getByLabel('Title').fill('Card payment fails with a valid card');
    await page.getByRole('button', { name: 'Report defect' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-D-1' })).toBeVisible();

    await page
      .getByRole('row', { name: /WEB-D-1/ })
      .getByRole('button', { name: 'Sync to Jira' })
      .click();
    await expect(page.getByRole('link', { name: 'WEB-3' })).toBeVisible();
  });
});
