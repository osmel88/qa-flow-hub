import { expect, test } from '@playwright/test';

/**
 * Product screens follow the selected language: switching to Spanish
 * translates the navigation, Projects and a Test Management screen, the choice
 * survives a reload, and project keys and names stay exactly as typed.
 */
const unique = Date.now();
const account = {
  email: `e2e-i18n-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Idioma Person',
};
const projectKey = `ES${String(unique).slice(-4)}`;

test('product screens switch between English and Spanish', async ({ page }) => {
  await test.step('a new account with an organization starts in English', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Idioma ${unique}`);
    await page.getByLabel('Slug').fill(`idioma-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('Projects is fully translated and keeps the data as typed', async () => {
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await page.getByRole('link', { name: 'Proyectos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Proyectos', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nuevo proyecto' })).toBeVisible();
    await expect(
      page.getByText('De 2 a 8 letras mayúsculas o dígitos, empezando por una letra.'),
    ).toBeVisible();
    await page.getByLabel('Nombre').fill('Tienda web');
    await page.getByLabel('Clave').fill(projectKey.toLowerCase());
    await page.getByRole('button', { name: 'Crear proyecto' }).click();

    const table = page.getByRole('table');
    await expect(table.getByText(projectKey, { exact: true })).toBeVisible();
    await expect(table.getByText('Tienda web')).toBeVisible();
    for (const header of ['Clave', 'Nombre', 'Estado', 'Acciones']) {
      await expect(table.getByRole('columnheader', { name: header })).toBeVisible();
    }
    await expect(table.getByRole('button', { name: 'Archivar' }).first()).toBeVisible();
    await expect(table.getByText('activo').first()).toBeVisible();
    await expect(page.getByText('Create project')).toHaveCount(0);
  });

  await test.step('the navigation has no English entry left', async () => {
    const nav = page.getByRole('navigation', { name: 'Principal' });
    for (const label of [
      'Panel',
      'Requisitos',
      'Casos de prueba',
      'Planes de prueba',
      'Defectos',
    ]) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    for (const label of ['Dashboard', 'Requirements', 'Test cases', 'Test plans', 'Defects']) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
  });

  await test.step('a Test Management screen is translated and survives a reload', async () => {
    await page.getByRole('link', { name: 'Planes de prueba', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Planes de prueba', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear plan de prueba' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Planes de prueba', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  });

  await test.step('switching back restores English', async () => {
    await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
    await expect(page.getByRole('heading', { name: 'Test plans', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
