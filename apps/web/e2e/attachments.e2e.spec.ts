import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

/**
 * Evidence uploads (S2-F7): a tester fails a case, attaches a screenshot and a
 * log to the failed result, sees them listed with type and size, previews the
 * image, downloads the log and gets the same bytes back, then deletes one and
 * it is gone. A file outside the allow-list and a file over the configured
 * limit are refused with a readable message and never reach the list.
 *
 * Bytes travel only through the authenticated API: the preview is a blob URL
 * built in the page, never a storage path.
 */
const unique = Date.now();
const password = 'Str0ngPassword!';

// A 1×1 PNG: valid signature, so the server's content sniffing accepts it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const LOG = `[${unique}] checkout failed: card declined\nstack: at pay()\n`;

test('a tester attaches evidence to a failed result, previews, downloads and deletes it', async ({
  page,
}) => {
  await test.step('register, create the organization, a project, a case and a run', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill('Evidence Tester');
    await page.getByLabel('Email').fill(`e2e-evidence-${unique}@example.com`);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Evidence ${unique}`);
    await page.getByLabel('Slug').fill(`evidence-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a valid card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-C-1' })).toBeVisible();

    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Name').fill('Release 1.0');
    await page.getByRole('button', { name: 'Create run' }).click();
    await page.getByRole('link', { name: 'Release 1.0' }).click();
    await page.getByRole('button', { name: 'Start run' }).click();
  });

  await test.step('fail the case: the evidence panel for the result appears', async () => {
    await page.getByRole('button', { name: /WEB-C-1/ }).click();
    await page.getByRole('button', { name: 'failed', exact: true }).click();
    await expect(page.getByText(/Latest result: failed/)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
  });

  const panel = page.getByRole('region', { name: /Evidence for latest result/ });
  const input = panel.getByLabel(/Choose a file/);

  await test.step('an unsupported type is refused before it is sent', async () => {
    await input.setInputFiles({
      name: 'payload.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ'),
    });
    await expect(panel.getByRole('alert')).toContainText('Unsupported file type');
    await expect(panel.getByText('No evidence attached yet.')).toBeVisible();
  });

  await test.step('a file over the limit is refused with the limit in the message', async () => {
    const limit = await panel.getByText(/up to /).textContent();
    expect(limit).toMatch(/up to [\d.]+ (KiB|MiB)/);
    // Over any dev limit the API can be configured with here (≥ 64 KiB in tests).
    await input.setInputFiles({
      name: 'huge.log',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(11 * 1024 * 1024, 0x61),
    });
    await expect(panel.getByRole('alert')).toContainText('File too large');
    await expect(panel.getByText('No evidence attached yet.')).toBeVisible();
  });

  await test.step('a screenshot and a log are uploaded and listed with type and size', async () => {
    await input.setInputFiles({ name: 'failure.png', mimeType: 'image/png', buffer: PNG });
    const image = panel.locator('.attachments__item', { hasText: 'failure.png' });
    await expect(image).toBeVisible();
    await expect(image).toContainText(`image/png · ${PNG.length} B`);
    await expect(image).toContainText('Evidence Tester');

    await input.setInputFiles({
      name: 'checkout.log',
      mimeType: 'text/plain',
      buffer: Buffer.from(LOG),
    });
    const log = panel.locator('.attachments__item', { hasText: 'checkout.log' });
    await expect(log).toBeVisible();
    await expect(log).toContainText(`text/plain · ${Buffer.byteLength(LOG)} B`);
    // Text is never offered inline: no preview button, download only.
    await expect(log.getByRole('button', { name: 'Preview' })).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });

  await test.step('the image previews from a blob, never from a storage path', async () => {
    await panel
      .locator('.attachments__item', { hasText: 'failure.png' })
      .getByRole('button', { name: 'Preview' })
      .click();
    const img = panel.getByRole('img', { name: 'failure.png' });
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => img.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(1);
    await panel.getByRole('button', { name: 'Close preview' }).click();
    await expect(img).toHaveCount(0);
  });

  await test.step('downloading the log returns the exact bytes under its name', async () => {
    const downloadPromise = page.waitForEvent('download');
    await panel
      .locator('.attachments__item', { hasText: 'checkout.log' })
      .getByRole('button', { name: 'Download' })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('checkout.log');
    const path = await download.path();
    expect((await readFile(path)).toString('utf8')).toBe(LOG);
  });

  await test.step('the tester deletes the screenshot and it disappears; the log stays', async () => {
    await panel
      .locator('.attachments__item', { hasText: 'failure.png' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(panel.locator('.attachments__item', { hasText: 'failure.png' })).toHaveCount(0);
    await expect(panel.locator('.attachments__item', { hasText: 'checkout.log' })).toHaveCount(1);

    await page.reload();
    await page.getByRole('button', { name: /WEB-C-1/ }).click();
    const after = page.getByRole('region', { name: /Evidence for latest result/ });
    await expect(after.locator('.attachments__item')).toHaveCount(1);
    await expect(after).toContainText('checkout.log');
  });
});
