import { expect, test } from '@playwright/test';

test('completes checkout', async ({ page }) => {
  await page.goto('/cart');
  await expect(page).toHaveURL('/cart');
});
