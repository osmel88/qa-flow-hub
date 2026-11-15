import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Flaky test detection (S7-F6), everything local: CI uploads JUnit reports in
 * which one case alternates and another passes; the Flaky tests page ranks
 * the alternating one, its stability page links each result to its run, and
 * a dismissal is recorded.
 */
const unique = Date.now();
const owner = {
  email: `e2e-flaky-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Flaky Owner',
};

const junit = (build: number, payFails: boolean): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ci-${build}">`,
    '  <testsuite name="checkout">',
    `    <testcase classname="pay.spec" name="FLK-C-1 pays with a card" time="1">${
      payFails ? '<failure message="timeout">stack</failure>' : ''
    }</testcase>`,
    '    <testcase classname="pay.spec" name="FLK-C-2 logs in" time="1"/>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n');

async function upload(page: Page, token: string, xml: string, runName: string) {
  return page.request.post(`/api/v1/ingest/junit?runName=${encodeURIComponent(runName)}`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: 'junit.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) },
    },
  });
}

test('flaky tests are detected from CI results, traced to runs and dismissed', async ({ page }) => {
  let token = '';

  await test.step('the owner sets up a project with two cases and an API key', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Flaky ${unique}`);
    await page.getByLabel('Slug').fill(`flaky-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Flaky');
    await page.getByLabel('Key').fill('FLK');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'FLK', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    for (const title of ['Pay with a card', 'Log in']) {
      await page.getByLabel('Title').fill(title);
      await page.getByRole('button', { name: 'Create case' }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }

    await page.getByRole('link', { name: 'API keys' }).click();
    await page.getByLabel('Key name').fill('CI');
    await page.getByRole('button', { name: 'Create key' }).click();
    token = await page.getByLabel('New API key token').inputValue();
    await page.getByRole('button', { name: 'I have copied it' }).click();
  });

  await test.step('CI uploads six builds; the card payment alternates', async () => {
    for (let build = 0; build < 6; build += 1) {
      const response = await upload(page, token, junit(build, build % 2 === 1), `Build ${build}`);
      expect(response.status()).toBe(200);
    }
  });

  await test.step('the Flaky tests page ranks and filters the cases', async () => {
    await page.getByRole('link', { name: 'Flaky tests' }).click();
    await expect(page.getByRole('heading', { name: 'Flaky tests' })).toBeVisible();
    const flaky = page.getByTestId('flaky-FLK-C-1');
    await expect(flaky).toContainText('flaky');
    await expect(flaky).toContainText('6 (0 manual · 6 automated)');
    await expect(flaky).toContainText('50%');
    await expect(page.getByTestId('flaky-FLK-C-2')).toContainText('stable');
    await page.getByLabel('Stability').selectOption('flaky');
    await expect(page.getByTestId('flaky-FLK-C-2')).toHaveCount(0);
    await expect(flaky).toBeVisible();
    await page.getByLabel('Result source').selectOption('manual');
    await expect(page.getByText('No executed case matches.')).toBeVisible();
    await page.getByLabel('Result source').selectOption('all');
    await page.getByRole('link', { name: 'FLK-C-1 · Pay with a card' }).click();
  });

  await test.step('the stability page traces each result and records a dismissal', async () => {
    await expect(page.getByRole('heading', { name: 'Stability of FLK-C-1' })).toBeVisible();
    await expect(page.getByTestId('flaky-status')).toHaveText('flaky');
    await expect(page.getByTestId('flaky-metrics')).toContainText('5 flips in 5 comparisons');
    const history = page.getByRole('table', { name: 'Result history' });
    await expect(history.getByRole('row')).toHaveCount(7);
    await expect(history.getByRole('link', { name: 'Build 5' })).toBeVisible();
    await page.getByLabel('Mark reason').fill('Known timeout on the shared CI runner');
    await page.getByRole('button', { name: 'Dismiss (not flaky)' }).click();
    await expect(page.getByTestId('flaky-status')).toHaveText('stable');
    await expect(page.getByRole('list', { name: 'Mark history' })).toContainText(
      'Known timeout on the shared CI runner',
    );
    await history.getByRole('link', { name: 'Build 5' }).click();
    await expect(page).toHaveURL(/\/test-runs\//);
  });
});
