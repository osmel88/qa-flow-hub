import { expect, test } from '@playwright/test';

/**
 * Changing the password from the profile: each field has its own show/hide
 * control, the confirmation must match, a wrong current password is reported
 * in the active language, and a successful change signs every session out.
 */
const unique = Date.now();
const account = {
  email: `e2e-profile-pw-${unique}@example.com`,
  password: 'Str0ngPassword!',
  newPassword: 'N3wStr0ngPassword!',
  fullName: 'Profile Person',
};

test('the profile changes the password with confirmation and show/hide', async ({ page }) => {
  await test.step('a new account opens its profile in Spanish', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Profile ${unique}`);
    await page.getByLabel('Slug').fill(`profile-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await page.getByRole('link', { name: 'Perfil', exact: true }).click();
  });

  const section = page.getByRole('region', { name: 'Cambiar contraseña' });
  const current = section.getByLabel('Contraseña actual', { exact: true });
  const next = section.getByLabel('Nueva contraseña', { exact: true });
  const confirm = section.getByLabel('Confirmar nueva contraseña', { exact: true });
  const submit = section.getByRole('button', { name: 'Cambiar contraseña' });

  await test.step('each field toggles on its own and a mismatch blocks the submit', async () => {
    await expect(submit).toBeDisabled();
    await next.fill(account.newPassword);
    await section.getByRole('button', { name: 'Mostrar contraseña' }).nth(1).click();
    await expect(next).toHaveAttribute('type', 'text');
    await expect(current).toHaveAttribute('type', 'password');
    await expect(confirm).toHaveAttribute('type', 'password');
    await expect(next).toHaveValue(account.newPassword);
    await current.fill('Wr0ngPassword!!');
    await confirm.fill(`${account.newPassword}x`);
    await expect(section.getByText('Las contraseñas no coinciden')).toBeVisible();
    await expect(submit).toBeDisabled();
  });

  await test.step('a wrong current password is reported and the fields are kept', async () => {
    await confirm.fill(account.newPassword);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(section.getByRole('alert')).toHaveText('La contraseña actual no es correcta.');
    await expect(next).toHaveValue(account.newPassword);
  });

  await test.step('the right current password changes it and signs out', async () => {
    await current.fill(account.password);
    await submit.click();
    await expect(section.getByRole('status')).toContainText('Contraseña cambiada');
    await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
    await page.getByLabel('Correo electrónico').fill(account.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(account.newPassword);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(
      page
        .getByRole('heading', { name: 'Tus organizaciones' })
        .or(page.getByRole('heading', { name: 'Panel' })),
    ).toBeVisible();
  });
});
