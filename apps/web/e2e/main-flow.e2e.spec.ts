import { expect, test } from '@playwright/test';

/**
 * The one end-to-end test: the path that makes the product worth buying.
 *
 * Register → organization → project → requirement → suite → case with steps →
 * run → execute → defect → traceability. Anything that breaks this chain
 * breaks the product, and no unit test can see the chain.
 *
 * It runs against a production build and a real API with a real database, so
 * a mistake in the proxy, the tenant header or a migration fails here.
 */
const unique = Date.now();
const account = {
  email: `e2e-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'End To End',
};

test('a QA lead can go from requirement to traced defect', async ({ page }) => {
  await test.step('register', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
  });

  await test.step('create the organization', async () => {
    await page.getByLabel('Name').fill(`Acme QA ${unique}`);
    await page.getByLabel('Slug').fill(`acme-qa-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('create the project', async () => {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();
  });

  await test.step('write a requirement', async () => {
    await page.getByRole('link', { name: 'Requirements' }).click();
    await page.getByLabel('Title').fill('The user can pay by card');
    await page.getByRole('button', { name: 'Create requirement' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-R-1' })).toBeVisible();
  });

  await test.step('design a case with steps', async () => {
    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();

    await page.getByLabel('Title').fill('Pay with a valid card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await page.getByRole('link', { name: 'Pay with a valid card' }).click();

    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('Step 1 action').fill('Submit the payment form');
    await page.getByLabel('Step 1 expected result').fill('The order is confirmed');
    await page.getByRole('button', { name: 'Save case' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
  });

  await test.step('execute the case and fail it', async () => {
    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Name').fill('Release 1.0');
    await page.getByRole('button', { name: 'Create run' }).click();
    await page.getByRole('link', { name: 'Release 1.0' }).click();

    await page.getByRole('button', { name: 'Start run' }).click();
    await page.getByRole('button', { name: /WEB-C-1/ }).click();
    await page.getByLabel('Comment').fill('The card was declined with a 500');
    await page.getByRole('button', { name: 'failed', exact: true }).click();

    // The snapshot is what the tester executed, and the defect shortcut only
    // appears for a result that is not a pass.
    await expect(page.getByText('Raise a defect linked to it?')).toBeVisible();
    await page.getByRole('button', { name: 'Raise defect' }).click();
  });

  await test.step('the defect exists and carries its origin', async () => {
    await page.getByRole('link', { name: 'Defects' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-D-1' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'From a test result' })).toBeVisible();
  });

  await test.step('the dashboard and the matrix agree with what happened', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByText('Open defects', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Traceability' }).click();
    await expect(page.getByRole('cell', { name: /WEB-R-1/ })).toBeVisible();
    // Nothing linked the requirement to the case, so the matrix must say
    // uncovered rather than flattering the report.
    await expect(page.getByText('0 of 1 covered')).toBeVisible();
  });
});

/**
 * The refresh token is a 30-day credential, so the browser must be able to use
 * it and unable to read it. This is the assertion that would have failed while
 * it lived in localStorage.
 */
test('a session survives a reload without any credential reachable from script', async ({
  page,
}) => {
  const email = `e2e-cookie-${Date.now()}@example.com`;

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Cookie Person');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain('refreshToken');
  expect(stored).not.toContain('qafh.refreshToken');

  const cookie = (await page.context().cookies()).find((item) => item.name === 'qafh_refresh');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');

  // Reload with nothing in memory: the session comes back only if the cookie
  // rotated successfully on boot.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
});
