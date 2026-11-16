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
      'Compilaciones',
      'Puertas de calidad',
      'Elementos de trabajo',
      'Pruebas exploratorias',
      'Pruebas inestables',
      'Claves de API',
      'Releases',
    ]) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    for (const label of [
      'Dashboard',
      'Requirements',
      'Test cases',
      'Test plans',
      'Defects',
      'Builds',
      'Quality gates',
      'Work items',
      'API keys',
    ]) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
  });

  await test.step('the header gives the translated selectors room and keeps the user on the right', async () => {
    const header = page.locator('.shell__header');
    const boxes = [];
    for (const name of ['Organización', 'Proyecto', 'Idioma']) {
      const box = await header.getByText(name, { exact: true }).locator('..').boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box!);
    }
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i]!.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width + 12);
    }
    expect(boxes[0]!.width).toBeGreaterThanOrEqual(224);
    const signOut = await header.getByRole('button', { name: 'Cerrar sesión' }).boundingBox();
    const headerBox = await header.boundingBox();
    expect(signOut!.x + signOut!.width).toBeGreaterThan(headerBox!.x + headerBox!.width - 40);

    await page.setViewportSize({ width: 390, height: 800 });
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1280, height: 720 });
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
