import { expect, test } from '@playwright/test';

/**
 * Login findings: show/hide password, password recovery with the mock email
 * provider (the link is shown on screen outside production), language
 * selector on public and in-app screens, and project key validation.
 */
const unique = Date.now();
const account = {
  email: `e2e-reset-${unique}@example.com`,
  password: 'Str0ngPassword!',
  newPassword: 'N3wPassword!!x',
  fullName: 'Reset Person',
};

test('password recovery, show/hide password, language selector and project key rule', async ({
  page,
  browser,
}) => {
  await test.step('an account with an organization validates project keys as typed', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Reset ${unique}`);
    await page.getByLabel('Slug').fill(`reset-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    const create = page.getByRole('button', { name: 'Create project' });
    await page.getByLabel('Name').fill('Web shop');
    await page.getByLabel('Key').fill('web-2');
    await expect(page.getByRole('alert')).toHaveText(
      '2 to 8 uppercase letters or digits, starting with a letter.',
    );
    await expect(create).toBeDisabled();
    await page.getByLabel('Key').fill('web2');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(create).toBeEnabled();
  });

  await test.step('the in-app language selector translates the navigation', async () => {
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(page.getByRole('link', { name: 'Proyectos', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Proyectos', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
    await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  });

  const other = await browser.newContext();
  const guest = await other.newPage();
  let resetPath = '';

  await test.step('the sign-in screen switches language and toggles the password', async () => {
    await guest.goto('/login');
    await guest.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(guest.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
    await guest.reload();
    await expect(guest.getByRole('link', { name: '¿Olvidaste tu contraseña?' })).toBeVisible();
    await guest.getByRole('combobox', { name: 'Idioma' }).selectOption('en');

    const password = guest.getByLabel('Password', { exact: true });
    await password.fill('typed-secret');
    await expect(password).toHaveAttribute('type', 'password');
    await guest.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(password).toHaveValue('typed-secret');
    await guest.getByRole('button', { name: 'Hide password' }).press('Enter');
    await expect(password).toHaveAttribute('type', 'password');
  });

  await test.step('forgot password shows the mock link and sets a new password', async () => {
    await guest.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(guest.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await guest.getByLabel('Email').fill(account.email);
    await guest.getByRole('button', { name: 'Send reset link' }).click();
    await expect(guest.getByRole('status')).toContainText('If an account exists');
    const link = guest.getByRole('link', { name: 'Open the reset link' });
    resetPath = (await link.getAttribute('href')) ?? '';
    expect(resetPath).toMatch(/^\/reset-password\?token=/);
    await link.click();
    await expect(guest).toHaveURL(/\/reset-password$/);
    await guest.getByLabel('New password', { exact: true }).fill(account.newPassword);
    await guest.getByLabel('Confirm new password', { exact: true }).fill(account.newPassword);
    await guest.getByRole('button', { name: 'Set new password' }).click();
    await expect(guest.getByRole('status')).toContainText('every session was signed out');
  });

  await test.step('the other session was revoked', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  await test.step('the old password fails, the new one works, the link is spent', async () => {
    await guest.goto('/login');
    await expect(guest.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await guest.getByLabel('Email').fill(account.email);
    await guest.getByLabel('Password', { exact: true }).fill(account.password);
    await guest.getByRole('button', { name: 'Sign in' }).click();
    await expect(guest.getByRole('alert')).toBeVisible();
    await guest.getByLabel('Password', { exact: true }).fill(account.newPassword);
    await guest.getByRole('button', { name: 'Sign in' }).click();
    await expect(guest.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await guest.goto(resetPath);
    await expect(guest.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await guest.getByLabel('New password', { exact: true }).fill('An0therPassword!');
    await guest.getByLabel('Confirm new password', { exact: true }).fill('An0therPassword!');
    await guest.getByRole('button', { name: 'Set new password' }).click();
    await expect(guest.getByRole('alert')).toContainText('invalid or has expired');
  });

  await other.close();
});
