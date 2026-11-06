import { test, expect } from '@playwright/test';
test('customer homepage fits screen and has no customer sign-in form', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your next journey/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Find a ride' })).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('unknown booking does not reveal passenger data', async ({ page }) => {
  await page.goto('/booking/unknown');
  await expect(page.getByRole('link', { name: 'Verify phone & retrieve booking' })).toBeVisible();
  await expect(page.getByText('Passenger', { exact: true })).toHaveCount(0);
});
test('admin and driver pages require staff sessions', async ({ page }) => {
  await page.goto('/admin/payments');
  await expect(page).toHaveURL(/staff\/sign-in/);
  await page.goto('/driver/trips');
  await expect(page).toHaveURL(/staff\/sign-in/);
});
