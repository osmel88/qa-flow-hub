import { expect, test } from '@playwright/test';

/**
 * Requirement ↔ work item (S4-F4): the owner links a story to a requirement,
 * follows the badges both ways, sees the implementation move to implemented
 * when the story is done, finds it in the traceability matrix and unlinks.
 */
const unique = Date.now();
const owner = {
  email: `e2e-impl-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Impl Owner',
};

test('requirement implemented by work items, both directions', async ({ page }) => {
  await test.step('the owner creates a requirement and a story', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Impl ${unique}`);
    await page.getByLabel('Slug').fill(`impl-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Impl');
    await page.getByLabel('Key').fill('IMP');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'IMP', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Requirements' }).click();
    await page.getByLabel('Title').fill('Customers pay by card');
    await page.getByRole('button', { name: 'Create requirement' }).click();
    await expect(page.getByRole('cell', { name: 'IMP-R-1' })).toBeVisible();

    await page.getByRole('link', { name: 'Work items' }).click();
    await expect(page.getByRole('heading', { name: 'New work item' })).toBeVisible();
    await expect(page.getByText('No work item matches.')).toBeVisible();
    await page.getByLabel('Title').fill('Card payment form');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByRole('link', { name: 'Card payment form' })).toBeVisible();
  });

  await test.step('the requirement detail links the story', async () => {
    await page.getByRole('link', { name: 'Requirements' }).click();
    await page.getByRole('link', { name: 'Customers pay by card' }).click();
    await expect(page.getByRole('heading', { name: 'Implemented by' })).toBeVisible();
    await expect(page.getByText('No work item implements this requirement yet.')).toBeVisible();
    await page.getByLabel('Link work item').selectOption({ label: 'IMP-W-1 · Card payment form' });
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    const section = page.getByRole('region', { name: 'Implemented by' });
    await expect(section.getByText('not implemented · 0/1')).toBeVisible();
  });

  await test.step('the badge leads to the work item, which links back', async () => {
    await page
      .getByRole('region', { name: 'Implemented by' })
      .getByRole('link', { name: /IMP-W-1/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Implements' })).toBeVisible();
    await page.getByLabel('Status').selectOption('done');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Work item saved.')).toBeVisible();
    await page
      .getByRole('region', { name: 'Implements' })
      .getByRole('link', { name: /IMP-R-1/ })
      .click();
    await expect(
      page.getByRole('region', { name: 'Implemented by' }).getByText('implemented · 1/1'),
    ).toBeVisible();
  });

  await test.step('the list filters by implementation and the matrix shows the chain', async () => {
    await page.getByRole('link', { name: '← All requirements' }).click();
    await page.getByLabel('Implementation').selectOption('not_implemented');
    await expect(page.getByText('No requirement matches these filters.')).toBeVisible();
    await page.getByLabel('Implementation').selectOption('implemented');
    await expect(page.getByRole('cell', { name: 'IMP-R-1' })).toBeVisible();

    await page.getByRole('link', { name: 'Traceability', exact: true }).click();
    await expect(page.getByRole('link', { name: 'IMP-W-1' })).toBeVisible();
  });

  await test.step('unlinking from the work item side clears the coverage', async () => {
    await page.getByRole('link', { name: 'IMP-W-1' }).click();
    await page.getByRole('button', { name: 'Unlink IMP-R-1' }).click();
    await expect(page.getByText('This item does not implement any requirement yet.')).toBeVisible();
  });
});
