import { expect, test } from '@playwright/test';

test('renders homepage', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Home/);
});
