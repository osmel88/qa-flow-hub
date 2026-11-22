import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The staging stabilization block: brand on the public screens, the register
 * form's field errors, plural header labels, the profile's organizations and
 * avatar, MFA input validation, project create/edit/archive/restore with the
 * role rule explained, and requirement edit/status/delete. Real API.
 */
const unique = Date.now();
const owner = {
  email: `e2e-stab-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Stab Owner',
};
const lead = {
  email: `e2e-stab-lead-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Stab Lead',
};

async function fillRegister(page: Page, values: { name: string; email: string; password: string }) {
  await page.getByLabel('Full name').fill(values.name);
  await page.getByLabel('Email').fill(values.email);
  await page.getByLabel('Password', { exact: true }).fill(values.password);
}

test('register reports each invalid field and a duplicate email', async ({ page, browser }) => {
  await test.step('the public screens show the brand', async () => {
    for (const path of ['/login', '/register', '/forgot-password', '/reset-password']) {
      await page.goto(path);
      await expect(page.getByTestId('brand')).toBeVisible();
      await expect(page.getByTestId('brand')).toHaveText('Veritest');
      await expect(page).toHaveTitle('Veritest');
      const logoLoaded = await page
        .locator('.brand__wordmark')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);
      expect(logoLoaded).toBe(true);
    }
  });

  await test.step('an incomplete form names the missing fields and creates nothing', async () => {
    await page.goto('/register');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page).toHaveURL(/\/register$/);
  });

  await test.step('an invalid email and a weak password are explained in Spanish', async () => {
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await page.getByLabel('Nombre completo').fill('Stab Owner');
    await page.getByLabel('Correo electrónico').fill('not-an-email');
    await page.getByLabel('Contraseña', { exact: true }).fill('weakpassword');
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(page.getByText('Introduce un correo electrónico válido')).toBeVisible();
    await expect(page.getByText('La contraseña debe contener una letra mayúscula')).toBeVisible();
    await expect(page.getByText(/Invalid|String must/)).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
  });

  await test.step('a valid form creates the account and opens the organizations', async () => {
    await fillRegister(page, {
      name: owner.fullName,
      email: owner.email,
      password: owner.password,
    });
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
  });

  await test.step('the same email again is reported on the email field', async () => {
    const other = await (await browser.newContext()).newPage();
    await other.goto('/register');
    await fillRegister(other, {
      name: 'Someone Else',
      email: owner.email,
      password: owner.password,
    });
    await other.getByRole('button', { name: 'Create account' }).click();
    await expect(
      other.getByText('An account with this email already exists. Sign in or use another email.'),
    ).toBeVisible();
    await expect(other.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  });
});

test('header, profile, MFA, projects and requirements after the stabilization', async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage();
  const leadPage = await (await browser.newContext()).newPage();
  const key = `S${String(unique).slice(-5)}`;
  let token = '';

  await test.step('the owner signs up, creates the organization and sees plural labels', async () => {
    await page.goto('/register');
    await fillRegister(page, {
      name: owner.fullName,
      email: `x-${owner.email}`,
      password: owner.password,
    });
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Stab ${unique}`);
    await page.getByLabel('Slug').fill(`stab-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const header = page.getByRole('banner');
    await expect(header.getByTestId('brand')).toBeVisible();
    await expect(header.getByRole('combobox', { name: 'Organizations' })).toBeVisible();
    await expect(header.getByRole('combobox', { name: 'Projects' })).toBeVisible();
    await expect(header.getByTestId('avatar')).toHaveText('SO');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(header.getByRole('combobox', { name: 'Organizaciones' })).toBeVisible();
    await expect(header.getByRole('combobox', { name: 'Proyectos' })).toBeVisible();
  });

  await test.step('the profile lists the organization, role and status in Spanish', async () => {
    await page.getByRole('link', { name: 'Perfil', exact: true }).click();
    await expect(page.getByText('Correo electrónico', { exact: true })).toBeVisible();
    const memberships = page.getByRole('region', { name: 'Organizaciones a las que perteneces' });
    const row = memberships.getByRole('row', { name: new RegExp(`Stab ${unique}`) });
    await expect(row).toContainText('propietario de la organización');
    await expect(row).toContainText('Activa');
  });

  await test.step('the profile edits the name and the header follows', async () => {
    await page.getByRole('button', { name: 'Editar nombre' }).click();
    const name = page.getByRole('textbox', { name: 'Nombre' });
    await name.fill('X');
    await expect(page.getByRole('button', { name: 'Guardar nombre' })).toBeDisabled();
    await name.fill('Zoe Ruiz');
    await page.getByRole('button', { name: 'Guardar nombre' }).click();
    await expect(page.getByRole('banner').getByTestId('avatar')).toHaveText('ZR');
    await expect(page.getByRole('banner').getByTestId('brand')).toContainText('Veritest');
  });

  await test.step('MFA setup stays disabled until the current password is typed', async () => {
    const setup = page.getByRole('button', { name: 'Configurar MFA' });
    await expect(setup).toBeDisabled();
    await expect(
      page.getByText('Introduce tu contraseña actual para empezar la configuración.'),
    ).toBeVisible();
    await page
      .getByRole('region', { name: 'Autenticación multifactor' })
      .getByLabel('Contraseña actual', { exact: true })
      .fill(owner.password);
    await expect(setup).toBeEnabled();
    await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
  });

  await test.step('a project is created, edited, archived with confirmation and restored', async () => {
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New project' })).toBeVisible();
    await page.getByLabel('Name').fill('Stab web');
    await page.getByLabel('Key').fill(key);
    await page.getByRole('button', { name: 'Create project' }).click();
    const row = page.getByRole('row', { name: new RegExp(key) });
    await expect(row).toContainText('Stab web');

    await row.getByRole('button', { name: `Edit ${key}` }).click();
    await row.getByLabel('Name').fill('Stab storefront');
    await row.getByLabel('Description').fill('The public shop');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('Stab storefront');
    await expect(row).toContainText('The public shop');

    await row.getByRole('button', { name: 'Archive' }).click();
    await expect(row).toContainText(`Archive ${key}? It becomes read-only until restored.`);
    await row.getByRole('button', { name: 'Yes, archive' }).click();
    await expect(row).toContainText('archived');
    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(row).toContainText('active');
    await expect(page.getByText(/Projects are archived, not deleted/)).toBeVisible();

    await row.getByRole('button', { name: `Open ${key}` }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('a requirement is edited, moved to review and deleted', async () => {
    await page.getByRole('link', { name: 'Requirements', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create requirement' })).toBeVisible();
    await page.getByLabel('Title').fill('Checkout accepts coupons');
    await page.getByRole('button', { name: 'Create requirement' }).click();
    await page.getByRole('link', { name: 'Checkout accepts coupons' }).click();

    const manage = page.getByRole('region', { name: 'Edit and status' });
    await manage.getByRole('button', { name: 'Edit requirement' }).click();
    await manage.getByLabel('Title').fill('Checkout accepts discount coupons');
    await manage.getByLabel('Acceptance criteria').fill('A valid coupon lowers the total.');
    await manage.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByRole('heading', { name: /Checkout accepts discount coupons/ }),
    ).toBeVisible();
    await expect(page.getByText('A valid coupon lowers the total.')).toBeVisible();

    await manage.getByLabel('Change status').selectOption('in_review');
    await expect(page.locator('.ui-badge', { hasText: 'in review' }).first()).toBeVisible();

    await manage.getByRole('button', { name: 'Delete requirement' }).click();
    await manage.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page).toHaveURL(/\/requirements$/);
    await expect(page.getByRole('link', { name: 'Checkout accepts discount coupons' })).toHaveCount(
      0,
    );
  });

  await test.step('a QA lead is told in Spanish that the role cannot create projects', async () => {
    await page.getByRole('link', { name: 'Members', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible();
    await page.getByLabel('Email').fill(lead.email);
    await page.getByLabel('Role', { exact: true }).selectOption('qa_lead');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const issued = page.getByRole('status').locator('code');
    await expect(issued).toBeVisible();
    token = (await issued.textContent()) ?? '';

    await leadPage.goto('/register');
    await fillRegister(leadPage, {
      name: lead.fullName,
      email: lead.email,
      password: lead.password,
    });
    await leadPage.getByRole('button', { name: 'Create account' }).click();
    await expect(leadPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await leadPage.getByLabel('Invitation token').fill(token);
    await leadPage.getByRole('button', { name: 'Join' }).click();
    await expect(leadPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await leadPage.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await leadPage.getByRole('link', { name: 'Proyectos', exact: true }).click();
    await expect(leadPage.getByRole('note')).toContainText(
      'Tu rol no permite crear proyectos en esta organización.',
    );
    await expect(leadPage.getByRole('button', { name: 'Crear proyecto' })).toBeDisabled();

    await leadPage.getByRole('link', { name: 'Perfil', exact: true }).click();
    await expect(
      leadPage.getByRole('region', { name: 'Organizaciones a las que perteneces' }),
    ).toContainText('líder de QA');
  });
});
