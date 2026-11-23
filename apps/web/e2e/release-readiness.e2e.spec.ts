import { expect, test } from '@playwright/test';

/**
 * Release readiness report (S7-F8): Release Detail shows the derived decision
 * of a release without evidence, in English and in Spanish, and the printable
 * report carries the release, the project, the date and the decision. The
 * decision rules themselves are covered by the integration suite.
 */
const unique = Date.now();
const owner = {
  email: `e2e-readiness-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Readiness Owner',
};

test('release readiness on Release Detail and as a printable report', async ({ page }) => {
  await test.step('the owner sets up a project and a release', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Readiness ${unique}`);
    await page.getByLabel('Slug').fill(`readiness-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Readiness');
    await page.getByLabel('Key').fill('RDY');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'RDY', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await page.getByLabel('Release name').fill('Spring launch');
    await page.getByLabel('Version').fill('2.4.0');
    await page.getByRole('button', { name: 'Create release' }).click();
    await page.getByRole('link', { name: 'Spring launch' }).click();
    await expect(page.getByRole('heading', { name: 'Spring launch · 2.4.0' })).toBeVisible();
  });

  await test.step('a release without evidence is INSUFFICIENT DATA', async () => {
    const section = page.getByRole('region', { name: 'Release readiness' });
    await expect(section.getByText('INSUFFICIENT DATA')).toBeVisible();
    await expect(section.getByText('Not enough evidence yet to decide responsibly.')).toBeVisible();
    await expect(
      section.getByText('Only 0 verdicts recorded; at least 5 are needed.').first(),
    ).toBeVisible();
    await expect(section.getByText('No quality gate applies to this release.')).toBeVisible();
  });

  await test.step('the same section in Spanish', async () => {
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    const section = page.getByRole('region', { name: 'Preparación de la release' });
    await expect(section.getByText('DATOS INSUFICIENTES')).toBeVisible();
    await expect(
      section.getByText('Solo hay 0 veredictos; se necesitan al menos 5.').first(),
    ).toBeVisible();
    await expect(
      section.getByRole('link', { name: 'Informe de preparación imprimible' }),
    ).toBeVisible();
    await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
  });

  await test.step('the printable report has release, project, date and decision', async () => {
    const href = await page
      .getByRole('link', { name: 'Printable readiness report' })
      .getAttribute('href');
    expect(href).toMatch(/^\/print\/releases\/.+\/readiness$/);
    await page.goto(href ?? '');
    await expect(
      page.getByRole('heading', { name: 'Readiness report: Spring launch · 2.4.0' }),
    ).toBeVisible();
    await expect(page.getByText(/RDY · Readiness · Generated/)).toBeVisible();
    await expect(page.getByText('INSUFFICIENT DATA')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Blockers' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Warnings' })).toBeVisible();
    await expect(page.getByRole('button', { name: /print/i })).toBeVisible();
  });
});
