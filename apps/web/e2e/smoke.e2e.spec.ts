import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke test: the built application loads and reaches the API.
 * The main-flow end-to-end test (register → organization → project → test case
 * → run → result → defect) is added with the frontend phase.
 */
test('the application shell loads and reports API status', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'qa-flow-hub', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'API status' })).toBeVisible();
  await expect(page.getByText('ok')).toBeVisible();
});
