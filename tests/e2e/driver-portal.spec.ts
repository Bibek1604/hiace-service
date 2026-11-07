import { test, expect, type Page } from '@playwright/test';
import { adminCredentials } from '../fixtures/api-client';

const { email: adminEmail, password: adminPassword } = adminCredentials();
const driverEmail = process.env.E2E_DRIVER_EMAIL || process.env.DRIVER_EMAIL || 'driver@sajiloyatra.com',
  driverPassword = process.env.E2E_DRIVER_PASSWORD || process.env.DRIVER_PASSWORD || 'SajiloDriver@2026!';

async function signIn(page: Page, role: string, email: string, password: string) {
  await page.goto('/staff/sign-in?role=' + role);
  await page.getByLabel('Workspace').selectOption(role);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(new RegExp('/' + role.toLowerCase()));
}
test('the admin seat layout editor still paints, saves and publishes', async ({ page }) => {
  await signIn(page, 'ADMIN', adminEmail, adminPassword);
  const origin = new URL(page.url()).origin;
  const owners = await (await page.request.get('/api/admin/owners')).json();
  const made = await page.request.post('/api/admin/seat-layouts', {
    headers: { Origin: origin },
    data: { operatorId: owners.items[0].id, name: 'Editor check ' + Date.now(), vehicleType: 'Hiace', template: 'hiace_17' },
  });
  expect(made.status()).toBe(201);
  const { id } = await made.json();
  await page.goto('/admin/seat-layouts/' + id);
  await expect(page.getByText(/17 seats..*Tap or drag/)).toBeVisible();

  // Erasing one seat and auto-labelling the rest proves painting reaches the saved draft.
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.getByRole('gridcell', { name: /Row 2, column 1: seat/ }).click();
  await expect(page.getByText(/16 seats..*Tap or drag/)).toBeVisible();
  await page.getByRole('button', { name: 'Auto-label seats' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.reload();
  await expect(page.getByText(/16 seats..*Tap or drag/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish version' }).click();
  await expect(page.getByRole('status')).toContainText('published');
});

test('only the admin uses the approval API, and the operator role is gone', async ({ page, request }) => {
  await signIn(page, 'DRIVER', driverEmail, driverPassword);
  expect((await page.request.get('/api/admin/driver-submissions')).status()).toBe(403);
  expect((await request.get('/api/admin/driver-submissions')).status()).toBe(401);
  expect((await request.get('/api/operator/trips')).status()).toBe(404);
  expect((await page.request.get('/api/operator/driver-submissions')).status()).toBe(404);
  const login = await request.post('/api/auth/login', {
    data: { role: 'OPERATOR', email: driverEmail, password: driverPassword },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(login.status()).toBe(400);
});
