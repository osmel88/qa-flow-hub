import { expect, test } from '@playwright/test';

/**
 * External traceability (S2-F5): the owner connects Jira, creates a
 * requirement and a defect, and reads the consolidated page — first as two
 * `missing` rows, then, after syncing the requirement from the page itself, as
 * one `synced` and one `missing`. The filters narrow the table, the internal
 * matrix at `/traceability` is untouched, and "Verify with providers" reports
 * what it checked.
 */
const unique = Date.now();
const password = 'Str0ngPassword!';

test('an owner reads and repairs the external traceability of a project', async ({ page }) => {
  await test.step('register, create the organization and connect Jira', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill('Traceability Owner');
    await page.getByLabel('Email').fill(`e2e-xtrace-${unique}@example.com`);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Trace ${unique}`);
    await page.getByLabel('Slug').fill(`trace-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Integrations' }).click();
    const jira = page.getByRole('region', { name: 'Jira' });
    await jira.getByLabel('Base URL').fill('https://jira.example.test');
    await jira.getByLabel('Configuration').fill('projectKey=WEB');
    await jira.getByRole('button', { name: 'Save' }).click();
    await expect(jira.getByRole('status')).toContainText('Configuration saved.');
    await jira.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(jira.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
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

    await page.getByRole('link', { name: 'Defects' }).click();
    await expect(page.getByRole('heading', { name: 'Report a defect' })).toBeVisible();
    await page.getByLabel('Title').fill('Card payment fails');
    await page.getByRole('button', { name: 'Report defect' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-D-1' })).toBeVisible();
  });

  await test.step('the page lists both entities as not linked yet', async () => {
    await page.getByRole('link', { name: 'External references' }).click();
    await expect(
      page.getByRole('heading', { name: 'External traceability', level: 1 }),
    ).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tbody tr[data-status="missing"]')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Summary' })).toContainText('missing: 2');
  });

  await test.step('syncing from the page turns the requirement row into synced', async () => {
    const row = page.getByRole('row', { name: /WEB-R-1/ });
    await row.getByRole('button', { name: 'Sync', exact: true }).click();
    const link = row.getByRole('link', { name: 'WEB-2' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://jira.example.test/browse/WEB-2');
    await expect(row).toHaveAttribute('data-status', 'synced');
    await expect(page.getByRole('row', { name: /WEB-D-1/ })).toHaveAttribute(
      'data-status',
      'missing',
    );
  });

  await test.step('filters narrow the table', async () => {
    await page.getByLabel('Status').selectOption('synced');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('row', { name: /WEB-R-1/ })).toBeVisible();

    await page.getByLabel('Status').selectOption('');
    await page.getByLabel('Entity type').selectOption('defect');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('row', { name: /WEB-D-1/ })).toBeVisible();

    await page.getByLabel('Entity type').selectOption('');
    await page.getByLabel('Provider').selectOption('testrail');
    await expect(page.getByText('No external references match')).toBeVisible();
    await page.getByLabel('Provider').selectOption('');
  });

  await test.step('verification checks the linked reference against the mock', async () => {
    await page.getByRole('button', { name: 'Verify with providers' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Verified 1 references: 1 present, 0 lost',
    );
    await expect(page.getByRole('row', { name: /WEB-R-1/ })).toContainText('verified');
  });

  await test.step('the internal matrix is a different screen', async () => {
    await page.getByRole('link', { name: 'Traceability', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Traceability', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: /WEB-R-1/ })).toBeVisible();
    await expect(page.getByText('Jira')).toHaveCount(0);
  });
});
