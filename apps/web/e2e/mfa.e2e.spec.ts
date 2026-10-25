import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * MFA (S3-F6): the owner enrols TOTP from the profile, saves the recovery
 * codes, requires MFA for the organization, and signs in again with the
 * two-step login — first a wrong code, then a recovery code.
 */
const unique = Date.now();
const owner = {
  email: `e2e-mfa-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Mfa Owner',
};

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 TOTP, independent of the API's implementation on purpose. */
function totp(secret: string, atMs = Date.now()): string {
  let bits = '';
  for (const char of secret) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0xf;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

test('TOTP enrolment, organization policy and two-step login', async ({ page }) => {
  let recoveryCode = '';
  let secret = '';

  await test.step('the owner creates an account and an organization', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Mfa ${unique}`);
    await page.getByLabel('Slug').fill(`mfa-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('requiring MFA is refused before the owner has it', async () => {
    await page.getByRole('link', { name: 'Members' }).click();
    const policy = page.getByRole('region', { name: 'Security' });
    await policy.getByLabel('Require multi-factor authentication').click();
    await expect(policy.getByRole('alert')).toContainText(/multi-factor/i);
    await expect(page.getByLabel('Require multi-factor authentication')).not.toBeChecked();
  });

  await test.step('the owner enrols an authenticator from the profile', async () => {
    await page.getByRole('link', { name: 'Profile' }).click();
    const section = page.getByRole('region', { name: 'Multi-factor authentication' });
    await section.getByLabel('Current password').fill(owner.password);
    await section.getByRole('button', { name: 'Set up MFA' }).click();
    secret = (await section.getByTestId('mfa-secret').textContent()) ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await section.getByLabel('Authentication code').fill(totp(secret));
    await section.getByRole('button', { name: 'Turn on MFA' }).click();

    const codes = section.getByTestId('recovery-codes');
    await expect(codes.getByRole('listitem')).toHaveCount(10);
    recoveryCode = (await codes.getByRole('listitem').first().textContent())?.trim() ?? '';
    expect(recoveryCode).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    await section.getByRole('button', { name: 'I saved them' }).click();
    await expect(section.getByTestId('recovery-codes')).toHaveCount(0);
    await expect(section.getByText('Verified with MFA', { exact: true })).toBeVisible();
    await expect(section.getByText(secret)).toHaveCount(0);
  });

  await test.step('the owner requires MFA for the organization', async () => {
    await page.getByRole('link', { name: 'Members' }).click();
    await page.getByLabel('Require multi-factor authentication').click();
    await expect(page.getByLabel('Require multi-factor authentication')).toBeChecked();
    const ownerRow = page.getByRole('row', { name: new RegExp(owner.email) });
    await expect(ownerRow.getByRole('cell', { name: 'Enabled', exact: true })).toBeVisible();
  });

  await test.step('signing in again needs the second factor', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto('/login');
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(recoveryCode);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('mfa-banner')).toHaveCount(0);

    await page.getByRole('link', { name: 'Profile' }).click();
    const section = page.getByRole('region', { name: 'Multi-factor authentication' });
    await expect(section.getByText('Verified with MFA', { exact: true })).toBeVisible();
    await expect(section.getByText('9', { exact: true })).toBeVisible();
  });
});
