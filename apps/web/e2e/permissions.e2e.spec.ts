import { expect, test } from '@playwright/test';

/**
 * Granular permissions (S2-F8): an owner invites a QA lead, revokes one of the
 * permissions their role would give them, and the API refuses the action even
 * though the form is still on screen — the UI hides nothing here on purpose, so
 * this proves the backend is the boundary. Granting it back restores the flow.
 * Two browser contexts, one per person, against the real API.
 */
const unique = Date.now();
const owner = {
  email: `e2e-perm-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Permission Owner',
};
const lead = {
  email: `e2e-perm-lead-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Permission Lead',
};

test('a project override is enforced by the API, not by hidden buttons', async ({ browser }) => {
  const ownerPage = await (await browser.newContext()).newPage();
  const leadPage = await (await browser.newContext()).newPage();

  let token = '';
  await test.step('the owner creates the organization, a project and invites a QA lead', async () => {
    await ownerPage.goto('/register');
    await ownerPage.getByLabel('Full name').fill(owner.fullName);
    await ownerPage.getByLabel('Email').fill(owner.email);
    await ownerPage.getByLabel('Password').fill(owner.password);
    await ownerPage.getByRole('button', { name: 'Create account' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();

    await ownerPage.getByLabel('Name').fill(`Permissions ${unique}`);
    await ownerPage.getByLabel('Slug').fill(`permissions-${unique}`);
    await ownerPage.getByRole('button', { name: 'Create' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Projects' }).click();
    await ownerPage.getByLabel('Name').fill('Web');
    await ownerPage.getByLabel('Key').fill('WEB');
    await ownerPage.getByRole('button', { name: 'Create project' }).click();
    await expect(ownerPage.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Members' }).click();
    await ownerPage.getByLabel('Email').fill(lead.email);
    await ownerPage.getByLabel('Role', { exact: true }).selectOption('qa_lead');
    await ownerPage.getByRole('button', { name: 'Send invitation' }).click();
    const issued = ownerPage.getByRole('status').locator('code');
    await expect(issued).toBeVisible();
    token = (await issued.textContent()) ?? '';
    expect(token.length).toBeGreaterThan(20);
  });

  await test.step('the QA lead joins and can create a requirement by role', async () => {
    await leadPage.goto('/register');
    await leadPage.getByLabel('Full name').fill(lead.fullName);
    await leadPage.getByLabel('Email').fill(lead.email);
    await leadPage.getByLabel('Password').fill(lead.password);
    await leadPage.getByRole('button', { name: 'Create account' }).click();
    await expect(leadPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await leadPage.getByLabel('Invitation token').fill(token);
    await leadPage.getByRole('button', { name: 'Join' }).click();
    await expect(leadPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await leadPage.getByRole('link', { name: 'Requirements' }).click();
    await leadPage.getByLabel('Title').fill('Checkout accepts coupons');
    await leadPage.getByRole('button', { name: 'Create requirement' }).click();
    await expect(leadPage.getByRole('cell', { name: 'Checkout accepts coupons' })).toBeVisible();
  });

  await test.step('the owner sees the permissions by module, sourced from the role', async () => {
    await ownerPage.getByRole('link', { name: 'Project access' }).click();
    await ownerPage.getByLabel(`Show the permissions of ${lead.email}`).click();
    const panel = ownerPage.getByRole('region', {
      name: `Permissions of ${lead.email} in this project`,
    });
    await expect(panel.getByText('Requirements', { exact: true })).toBeVisible();
    await expect(panel.getByText('Executions', { exact: true })).toBeVisible();
    const row = panel.locator('[data-permission="requirements.write"]');
    await expect(row).toContainText('Allowed');
    await expect(row).toContainText('role');
  });

  await test.step('the owner revokes requirements.write for this project only', async () => {
    const panel = ownerPage.getByRole('region', {
      name: `Permissions of ${lead.email} in this project`,
    });
    await panel.getByLabel(`Override requirements.write for ${lead.email}`).selectOption('revoke');
    await panel.getByRole('button', { name: 'Save overrides' }).click();
    await expect(panel.getByRole('status')).toContainText('Overrides saved');
    const row = panel.locator('[data-permission="requirements.write"]');
    await expect(row).toContainText('Not allowed');
    await expect(row).toContainText('override');
    await expect(panel.getByText('1 in this project')).toBeVisible();
  });

  await test.step('the form is still there, but the API now refuses the QA lead', async () => {
    await leadPage.getByLabel('Title').fill('Checkout accepts gift cards');
    await leadPage.getByRole('button', { name: 'Create requirement' }).click();
    await expect(leadPage.getByRole('alert')).toBeVisible();
    await expect(leadPage.getByRole('cell', { name: 'Checkout accepts gift cards' })).toHaveCount(
      0,
    );
    await expect(leadPage.getByRole('cell', { name: 'Checkout accepts coupons' })).toBeVisible();
  });

  await test.step('the QA lead cannot open anybody else’s overrides', async () => {
    await leadPage.getByRole('link', { name: 'Project access' }).click();
    await leadPage.getByLabel(`Show the permissions of ${lead.email}`).click();
    const panel = leadPage.getByRole('region', {
      name: `Permissions of ${lead.email} in this project`,
    });
    await expect(panel.locator('[data-permission="requirements.write"]')).toContainText(
      'Not allowed',
    );
    await expect(panel.getByRole('combobox')).toHaveCount(0);
    await expect(leadPage.getByLabel(`Set the project role of ${owner.email}`)).toHaveCount(0);
  });

  await test.step('back to the role default, the QA lead writes again', async () => {
    const panel = ownerPage.getByRole('region', {
      name: `Permissions of ${lead.email} in this project`,
    });
    await panel.getByLabel(`Override requirements.write for ${lead.email}`).selectOption('default');
    await panel.getByRole('button', { name: 'Save overrides' }).click();
    await expect(panel.getByRole('status')).toContainText('Overrides saved');
    await expect(panel.locator('[data-permission="requirements.write"]')).toContainText('Allowed');

    await leadPage.getByRole('link', { name: 'Requirements' }).click();
    await leadPage.getByLabel('Title').fill('Checkout accepts gift cards');
    await leadPage.getByRole('button', { name: 'Create requirement' }).click();
    await expect(leadPage.getByRole('cell', { name: 'Checkout accepts gift cards' })).toBeVisible();
  });
});
