import { test, expect } from '@playwright/test';
import { adminCredentials, seedScenario } from '../fixtures/api-client';

/**
 * Browser flows against a running server (E2E_BASE_URL, default http://localhost:3000) whose database
 * holds the seeded admin account. Each test seeds its own driver, vehicle and trip through the API.
 */
const base = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

test('a passenger finds the trip, picks a seat, holds it and sees the payment QR', async ({ page }) => {
  const s = await seedScenario(base);
  await page.goto(`/search?origin=${encodeURIComponent(s.names.origin)}&destination=${encodeURIComponent(s.names.dest)}&date=`);
  await expect(page.getByRole('heading', { name: new RegExp('Hiace ' + s.id) })).toBeVisible();
  await page.getByRole('link', { name: /Choose seats/ }).first().click();
  await expect(page).toHaveURL(new RegExp('/trips/' + s.tripId));
  await expect(page.getByRole('heading', { name: 'Pick your favourite seat' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'trip page fits the screen').toBe(true);
  const seat = page.locator('button.seat.available').first();
  await expect(seat).toBeVisible();
  await seat.click();
  await expect(page.getByRole('button', { name: /Continue/ })).toBeEnabled();
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByLabel('Passenger name').fill('Playwright Passenger');
  await page.getByLabel('Mobile number').fill('9841234567');
  await page.getByLabel('Email (optional)').fill(`pw-${s.id}@test.local`);
  await page.getByRole('button', { name: /Hold seats/ }).click();
  await expect(page).toHaveURL(/\/booking\/[a-z0-9]+$/, { timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pay securely by QR' })).toBeVisible();
  await expect(page.locator('img.qr-image')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^SY-[A-Z0-9]{12}$/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the admin signs in, sees the records, and deletes a spare vehicle from the table', async ({ page }) => {
  const s = await seedScenario(base);
  const spare = await s.admin.post<{ id: string }>('/api/admin/vehicles', {
    operatorId: s.operatorId,
    name: 'Spare bus ' + s.id,
    registration: 'SPARE-' + s.id,
    type: 'Bus',
    operator: 'E2E Travels ' + s.id,
    operatorContact: '9800000001',
    emergencyContact: '9800000002',
    seatLabels: ['A1', 'A2'],
  });
  expect(spare.status).toBe(201);
  const admin = adminCredentials();
  await page.goto('/staff/sign-in?role=ADMIN');
  await page.getByLabel('Workspace').selectOption('ADMIN');
  await page.getByLabel('Email', { exact: true }).fill(admin.email);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page).toHaveURL(/admin\/dashboard/, { timeout: 20000 });
  // The admin sees every driver's records, so search for this scenario's.
  await page.goto('/admin/vehicles');
  await page.getByLabel('Search vehicles').fill(s.id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const spareCell = page.getByRole('cell', { name: 'Spare bus ' + s.id, exact: true });
  await expect(spareCell).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete Spare bus ' + s.id }).click();
  await expect(spareCell).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByRole('cell', { name: 'Hiace ' + s.id, exact: true })).toBeVisible();
  await page.goto('/admin/trips');
  await page.getByLabel('Search trips').fill(s.id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Hiace ' + s.id, exact: true })).toBeVisible();
});

test('wrong passwords never lock a staff account and the email field survives each attempt', async ({ page }) => {
  const s = await seedScenario(base);
  await page.goto('/staff/sign-in?role=DRIVER');
  await page.getByLabel('Email', { exact: true }).fill(s.driver.email);
  // Each attempt waits for the server's answer, so the next click never lands on a busy form.
  const attempt = async (password: string) => {
    await page.getByLabel('Password', { exact: true }).fill(password);
    const response = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
    await page.getByRole('button', { name: 'Sign in securely' }).click();
    return (await response).status();
  };
  for (let i = 0; i < 6; i++) {
    expect(await attempt('wrong-password-' + i), 'attempt ' + i).toBe(401);
    await expect(page.locator('div.error[role="alert"]')).toHaveText(/email or password is incorrect|Invalid credentials/);
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(s.driver.email);
    await expect(page.getByRole('button', { name: 'Sign in securely' })).toBeEnabled();
  }
  expect(await attempt(s.driver.password), 'the right password after six wrong ones').toBe(200);
  await expect(page).toHaveURL(/driver\/trips/, { timeout: 20000 });
});
