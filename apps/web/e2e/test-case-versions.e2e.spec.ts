import { expect, test } from '@playwright/test';

/**
 * Test case versioning (S7-F4), everything local: content edits create
 * versions, a run keeps the version it executed, and restore copies an old
 * version into a new one without rewriting history.
 */
const unique = Date.now();
const owner = {
  email: `e2e-versions-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Versions Owner',
};

test('a case keeps immutable versions, runs cite theirs and restore adds a new one', async ({
  page,
}) => {
  const openCase = async (title: string) => {
    await page.getByRole('link', { name: 'Test cases', exact: true }).click();
    await page.getByRole('button', { name: /Checkout/ }).click();
    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
  };
  const versions = page.getByRole('table', { name: 'Versions' });

  await test.step('the owner creates a case', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Versions ${unique}`);
    await page.getByLabel('Slug').fill(`versions-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Versions');
    await page.getByLabel('Key').fill('VER');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'VER', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await openCase('Pay with a card');
    await expect(versions.getByTestId('case-version-1')).toContainText('(current)');
  });

  await test.step('a content edit with a reason creates version 2', async () => {
    await page.getByLabel('Title', { exact: true }).fill('Pay with a saved card');
    await page.getByLabel('Change reason (optional)').fill('Saved cards');
    await page.getByRole('button', { name: 'Save case' }).click();
    await expect(page.getByText('Saved as version 2.')).toBeVisible();
    await expect(versions.getByTestId('case-version-2')).toContainText('Saved cards');
    await expect(versions.getByTestId('case-version-2')).toContainText(owner.fullName);
  });

  await test.step('a run executes version 2 and its result cites it', async () => {
    await page.getByRole('link', { name: 'Test runs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Test runs', level: 1 })).toBeVisible();
    await page.getByLabel('Name').fill('Versioned run');
    await page.getByRole('button', { name: 'Create run' }).click();
    await page.getByRole('link', { name: 'Versioned run' }).click();
    await page.getByRole('button', { name: /Pay with a saved card/ }).click();
    await expect(page.getByRole('link', { name: 'v2' })).toBeVisible();
    await page.getByRole('button', { name: 'Passed' }).click();
    await expect(page.getByText(/Latest result: passed .* on version 2/i)).toBeVisible();
  });

  await test.step('history, diff and restore never rewrite the past', async () => {
    await openCase('Pay with a saved card');
    await page.getByLabel('Title', { exact: true }).fill('Pay with a voucher');
    await page.getByRole('button', { name: 'Save case' }).click();
    await expect(page.getByText('Saved as version 3.')).toBeVisible();

    await page.getByLabel('Compare from').selectOption('1');
    await page.getByLabel('Compare to').selectOption('3');
    const differences = page.getByRole('list', { name: 'Differences' });
    await expect(differences).toContainText('title');
    await expect(differences).toContainText('Pay with a card');
    await expect(differences).toContainText('Pay with a voucher');

    await page.getByRole('button', { name: 'View version 1' }).click();
    await expect(page.getByLabel('Version 1 content')).toContainText('Pay with a card');

    await page.getByLabel('Restore reason (optional)').fill('Vouchers were dropped');
    await page.getByRole('button', { name: 'Restore version 1' }).click();
    await expect(page.getByText('Restored version 1 as version 4.')).toBeVisible();
    await expect(versions.getByTestId('case-version-4')).toContainText('restored from v1');
    await expect(versions.getByTestId('case-version-4')).toContainText('Vouchers were dropped');
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Pay with a card');

    await page.getByRole('link', { name: 'Test runs', exact: true }).click();
    await page.getByRole('link', { name: 'Versioned run' }).click();
    await page.getByRole('button', { name: /Pay with a saved card/ }).click();
    await expect(page.getByRole('link', { name: 'v2' })).toBeVisible();
    await page.getByRole('link', { name: 'v2' }).click();
    await expect(page.getByLabel('Version 2 content')).toContainText('Pay with a saved card');
  });
});
