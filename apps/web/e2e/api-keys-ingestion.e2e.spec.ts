import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * API keys and report ingestion (S3-F3): a project manager creates a key, the
 * token is shown once, CI uploads a JUnit report that records results in a
 * new run, a re-upload is recognised as a duplicate, a DTD is refused, and the
 * key stops working as soon as it is revoked.
 */
const unique = Date.now();
const owner = {
  email: `e2e-ingest-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Ingest Owner',
};

const junit = (marker: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ci-${marker}">`,
    '  <testsuite name="checkout">',
    '    <testcase classname="pay.spec" name="ING-C-1 pays with a card" time="1.5"/>',
    '    <testcase classname="pay.spec" name="ING-C-1 pays with a saved card" time="0.5">',
    '      <failure message="Expected the order to be confirmed">stack</failure>',
    '    </testcase>',
    '    <testcase classname="pay.spec" name="no case key here" time="0.1"/>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n');

async function upload(page: Page, token: string, xml: string, runName = 'CI build 42') {
  return page.request.post(`/api/v1/ingest/junit?runName=${encodeURIComponent(runName)}`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: 'junit.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) },
    },
  });
}

test('API key lifecycle and JUnit ingestion into a test run', async ({ page }) => {
  let token = '';

  await test.step('the owner sets up an organization, a project and a case', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Ingest ${unique}`);
    await page.getByLabel('Slug').fill(`ingest-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Ingestion');
    await page.getByLabel('Key').fill('ING');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'ING', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('link', { name: 'Pay with a card' })).toBeVisible();
  });

  await test.step('a key is created and its token is shown only once', async () => {
    await page.getByRole('link', { name: 'API keys' }).click();
    await page.getByLabel('Key name').fill('GitHub Actions');
    await page.getByRole('button', { name: 'Create key' }).click();
    const field = page.getByLabel('New API key token');
    await expect(field).toHaveValue(/^qfh_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    token = await field.inputValue();
    await page.getByRole('button', { name: 'I have copied it' }).click();
    await expect(page.getByLabel('New API key token')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('cell', { name: 'GitHub Actions', exact: true })).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);
  });

  await test.step('CI uploads a JUnit report; a re-upload is a duplicate', async () => {
    const first = await upload(page, token, junit('a'));
    expect(first.status()).toBe(200);
    const body = (await first.json()) as {
      duplicate: boolean;
      report: { testRunId: string | null; summary: { recorded: number; unmatched: number } };
    };
    expect(body.duplicate).toBe(false);
    expect(body.report.testRunId).not.toBeNull();
    expect(body.report.summary).toMatchObject({ recorded: 1, unmatched: 1 });

    const again = await upload(page, token, junit('a'));
    expect(again.status()).toBe(200);
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);

    const dtd = await upload(
      page,
      token,
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite>&e;</testsuite>',
    );
    expect(dtd.status()).toBe(400);
    expect(((await dtd.json()) as { error: { code: string } }).error.code).toBe('INVALID_REPORT');

    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByRole('link', { name: 'CI build 42' }).click();
    await expect(page.getByText('Pay with a card')).toBeVisible();
    await expect(page.getByText(/failed/i).first()).toBeVisible();

    await page.getByRole('link', { name: 'API keys' }).click();
    await expect(page.getByRole('cell', { name: 'junit.xml' })).toHaveCount(1);
  });

  await test.step('a revoked key is refused on the very next request', async () => {
    await page.getByRole('button', { name: 'Revoke GitHub Actions' }).click();
    await expect(page.getByText('revoked', { exact: true })).toBeVisible();
    const refused = await upload(page, token, junit('b'));
    expect(refused.status()).toBe(401);
  });
});
