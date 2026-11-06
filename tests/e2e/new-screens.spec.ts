import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { adminCredentials, seedScenario } from '../fixtures/api-client';

const base = process.env.E2E_BASE_URL || 'http://localhost:3000';
const shots = process.env.E2E_SHOTS;

async function signIn(page: import('@playwright/test').Page, role: string, email: string, password: string) {
  await page.goto('/staff/sign-in?role=' + role);
  await page.getByLabel('Workspace').selectOption(role);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
}

test('admin cancels a booking from its detail panel and adds a driver without losing input on error', async ({ page }, info) => {
  const s = await seedScenario(base);
  const trip = await s.admin.get<{ seats: { id: string; state: string }[] }>(`/api/trips/${s.tripId}`);
  const seat = trip.data.seats.find((x) => x.state === 'AVAILABLE')!.id;
  const walkIn = await s.admin.post<{ reference: string }>('/api/admin/manual-bookings', {
    tripId: s.tripId, seats: [seat], name: 'Hari Walkin', phone: '9841000009', idempotencyKey: randomUUID() + randomUUID(),
    method: 'CASH', confirm: true, note: 'Paid cash at counter', bankEvidence: 'receipt 9',
  });
  expect(walkIn.status).toBe(201);
  const admin = adminCredentials();
  await signIn(page, 'ADMIN', admin.email, admin.password);
  await expect(page).toHaveURL(/admin\/dashboard/, { timeout: 20000 });
  await expect(page.getByText('Open refunds')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/dashboard-${info.project.name}.png`, fullPage: true });

  // Bookings: search, open, cancel.
  await page.goto('/admin/bookings');
  await page.getByLabel('Search bookings').fill(walkIn.data.reference);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('cell', { name: walkIn.data.reference })).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('button', { name: 'Print ticket' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/booking-detail-${info.project.name}.png` });
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await page.getByLabel('Reason *').fill('Customer changed plans');
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText('Booking cancelled. Its seats are available again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve refund' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/booking-cancelled-${info.project.name}.png` });
  await page.keyboard.press('Escape');

  // Trips: manifest link and cancel action are present.
  await page.goto('/admin/trips');
  await expect(page.getByRole('link', { name: 'Manifest' }).first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/trips-${info.project.name}.png`, fullPage: true });

  // Drivers: a refused submission keeps what was typed.
  await page.goto('/admin/drivers/new');
  const form = page.locator('form.admin-form');
  await page.getByLabel('Full name *').fill('Gita Driver');
  await page.getByLabel('Staff email *').fill(s.driver.email);
  await page.getByLabel(/^Password/).fill('Driver-password-1');
  await page.getByLabel('Mobile *').fill('9800000011');
  await page.getByLabel('License number *').fill('GITA-' + s.id);
  await page.getByLabel('License expiry *').fill('2036-01-01T10:00');
  await page.getByLabel('Emergency contact *').fill('9800000012');
  const submit = form.locator('button[type=submit], button:not([type])').last();
  await submit.click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Full name *')).toHaveValue('Gita Driver');
  await page.getByLabel('Staff email *').fill(`gita-${s.id}@test.local`);
  if (shots) await page.screenshot({ path: `${shots}/driver-form-${info.project.name}.png` });
  await submit.click();
  await expect(form).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/drivers-${info.project.name}.png`, fullPage: true });
});

test('admin edits a public text label and the site shows it', async ({ page, request }, info) => {
  const s = await seedScenario(base);
  const current = (await s.admin.get<Record<string, unknown> & { copy: { search: Record<string, string> } }>('/api/admin/site-content')).data;
  try {
    const admin = adminCredentials();
    await signIn(page, 'ADMIN', admin.email, admin.password);
    await expect(page).toHaveURL(/admin\/dashboard/, { timeout: 20000 });
    await page.goto('/admin/website');
    await page.getByText('Search and results').click();
    await page.getByLabel('Search page title').fill('Ghumna jaau, sajilo sanga.');
    if (shots) await page.screenshot({ path: `${shots}/website-text-${info.project.name}.png` });
    await page.getByRole('button', { name: 'Save website content' }).click();
    await expect(page.getByText('Saved. The public site now shows these changes.')).toBeVisible();
    const html = await (await request.get(base + '/search')).text();
    expect(html).toContain('Ghumna jaau, sajilo sanga.');
  } finally {
    await s.admin.patch('/api/admin/site-content', current);
  }
});
