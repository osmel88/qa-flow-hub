import { expect, test } from '@playwright/test';

/**
 * The cheapest possible check that the built bundle is alive: an anonymous
 * visitor is sent to the sign-in screen instead of an application shell. It
 * fails fast on a broken build or a bad proxy, before the main-flow test
 * spends a minute discovering the same thing.
 */
test('an anonymous visitor lands on the sign-in screen', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});
