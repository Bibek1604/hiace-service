import { test, expect } from '@playwright/test';
const hasAdmin = !!process.env.E2E_ADMIN_EMAIL && !!process.env.E2E_ADMIN_PASSWORD;
const hasDriver =
  !!process.env.E2E_DRIVER_EMAIL &&
  !!process.env.E2E_DRIVER_PASSWORD &&
  !!process.env.E2E_FOREIGN_TRIP_ID;
test('admin confirmation is required and admin session has no driver privileges', async ({
  page,
}) => {
  test.skip(!hasAdmin, 'Provide staging admin credentials; never use production data.');
  await page.goto('/staff/sign-in');
  await page.getByLabel('Workspace').selectOption('ADMIN');
  await page.getByLabel('Email', { exact: true }).fill(process.env.E2E_ADMIN_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page).toHaveURL(/admin\/dashboard/);
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/driver/trips');
    return r.status;
  });
  expect(status).toBe(403);
  await page.goto('/admin/payments');
  const verify = page.getByRole('button', { name: 'Verify payment', exact: true }).first();
  if (await verify.count()) {
    await verify.click();
    await expect(
      page.getByRole('heading', { name: 'Confirm bank / wallet verification' }),
    ).toBeVisible();
    await expect(
      page.getByLabel('I checked the actual transaction and confirm receipt.'),
    ).not.toBeChecked();
  }
});
test('authenticated driver cannot access admin payments or a foreign manifest', async ({
  page,
}) => {
  test.skip(!hasDriver, 'Provide a staging driver account and a trip assigned to another driver.');
  await page.goto('/staff/sign-in');
  await page.getByLabel('Workspace').selectOption('DRIVER');
  await page.getByLabel('Email', { exact: true }).fill(process.env.E2E_DRIVER_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_DRIVER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page).toHaveURL(/driver\/trips/);
  const statuses = await page.evaluate(async (id) => {
    return Promise.all(
      ['/api/admin/payments', '/api/driver/passengers?tripId=' + encodeURIComponent(id)].map(
        async (url) => (await fetch(url)).status,
      ),
    );
  }, process.env.E2E_FOREIGN_TRIP_ID!);
  expect(statuses).toEqual([403, 404]);
});
