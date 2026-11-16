import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * QA metrics dashboard (S7-F7), everything local: CI uploads six JUnit reports
 * in which one case alternates; the QA metrics page shows the execution KPIs,
 * the flaky count and the trend, and an empty period hides every percentage.
 */
const unique = Date.now();
const owner = {
  email: `e2e-qa-metrics-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Metrics Owner',
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

test('the QA metrics page consolidates results, flaky tests and filters', async ({ page }) => {
  let token = '';

  await test.step('the owner sets up a project with two cases and an API key', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill(owner.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`Metrics ${unique}`);
    await page.getByLabel('Slug').fill(`qa-metrics-${unique}`);
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

  await test.step('the QA metrics page shows execution, rates, trend and flaky counts', async () => {
    await page.getByRole('link', { name: 'QA metrics' }).click();
    await expect(page.getByRole('heading', { name: 'QA metrics', level: 1 })).toBeVisible();
    const kpi = (label: string) => page.locator('.metric').filter({ hasText: label });
    await expect(kpi('Runs in scope')).toContainText('6');
    await expect(kpi('Execution coverage')).toContainText('100%');
    await expect(kpi('Execution coverage')).toContainText('12 of 12 executed');
    await expect(kpi('Pass rate')).toContainText('75%');
    await expect(kpi('Fail rate')).toContainText('25%');
    await expect(kpi('Blocked rate')).toContainText('0%');
    const trend = page.getByRole('region', { name: 'Results over time' });
    await expect(trend.getByRole('cell', { name: '9', exact: true })).toBeVisible();
    const flaky = page.getByRole('region', { name: 'Flaky tests' });
    await expect(flaky.getByRole('listitem').filter({ hasText: 'flaky' }).first()).toContainText(
      '1',
    );
    await expect(page.getByText('No test plans match these filters.')).toBeVisible();
    await expect(page.getByText('No exploratory sessions in this period.')).toBeVisible();
  });

  await test.step('a period without data shows empty states and no percentages', async () => {
    await page.getByLabel('From', { exact: true }).fill('2020-01-01');
    await page.getByLabel('To', { exact: true }).fill('2020-01-31');
    await expect(page.getByText('Period: 2020-01-01 – 2020-02-01')).toBeVisible();
    const kpi = (label: string) => page.locator('.metric').filter({ hasText: label });
    await expect(kpi('Runs in scope')).toContainText('0');
    await expect(kpi('Pass rate')).toContainText('—');
    await expect(page.getByText('No results were recorded in this period.')).toBeVisible();
    await page.getByLabel('To', { exact: true }).fill('2019-12-01');
    await expect(page.getByText('“From” must be before “To”.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(kpi('Runs in scope')).toContainText('6');
  });
});
