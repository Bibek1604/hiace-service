import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

const adminEmail = process.env.E2E_ADMIN_EMAIL || 'admin@sajiloyatra.com',
  adminPassword = process.env.E2E_ADMIN_PASSWORD || 'SajiloAdmin@2026!';

async function signIn(page: Page, role: string, email: string, password: string) {
  await page.goto('/staff/sign-in?role=' + role);
  await page.getByLabel('Workspace').selectOption(role);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(new RegExp('/' + role.toLowerCase()));
}
const signOut = (page: Page) => page.context().clearCookies();
const picture = async (background: string) => ({
  name: 'picture.png',
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 240, height: 240, channels: 3, background } }).png().toBuffer(),
});
async function approveAll(page: Page, driver: string, count: number) {
  await page.goto('/admin/driver-requests');
  const cards = page.locator('article').filter({ hasText: driver });
  await expect(cards).toHaveCount(count);
  for (let left = count; left > 0; left--) {
    await cards.first().getByRole('button', { name: 'Approve' }).click();
    await expect(cards).toHaveCount(left - 1);
  }
}

test('an owner-driver goes from an admin-made account to a bookable trip', async ({ page }) => {
  test.setTimeout(240000);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name = 'Maya ' + id,
    email = `maya-${id}@test.local`,
    password = 'Maya-password-' + id,
    number = 'BA ' + id;
  await signIn(page, 'ADMIN', adminEmail, adminPassword);

  // Admin creates the driver; their private company is made with them.
  await page.goto('/admin/drivers/new');
  await page.getByLabel('Full name *').fill(name);
  await page.getByLabel('Staff email *').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByLabel('Mobile *').fill('9800000011');
  await page.getByLabel('License number *').fill('L-' + id);
  await page.getByLabel('License expiry *').fill('2036-01-01T10:00');
  await page.getByLabel('Emergency contact *').fill('9800000012');
  await page.locator('form.admin-form button[type=submit], form.admin-form button:not([type])').last().click();
  await expect(page.locator('form.admin-form')).toHaveCount(0);
  await signOut(page);

  // The driver sees the full panel and edits their own details.
  await signIn(page, 'DRIVER', email, password);
  await page.goto('/driver/profile');
  await page.getByLabel('Address').fill('Lakeside, Pokhara');
  await page.getByRole('button', { name: 'Save my details' }).click();
  await expect(page.getByRole('status')).toContainText('profile was saved');

  // Vehicle with a seat plan from a template, shown in the shared editor.
  await page.goto('/driver/vehicles');
  await page.getByRole('button', { name: 'Add vehicle' }).click();
  await page.getByLabel('Vehicle name *').fill('Maya Van');
  await page.getByLabel('Vehicle number *').fill(number);
  await page.getByLabel('Vehicle type *').selectOption('Hiace');
  await page.getByLabel('Emergency contact *').fill('9800000012');
  await page.getByLabel('Amenities (comma separated)').fill('AC, Wi-Fi');
  await page.getByLabel('Vehicle photos').setInputFiles(await picture('#2266aa'));
  await expect(page.getByAltText('Uploaded')).toBeVisible();
  await page.getByLabel('Seat plan *').selectOption({ label: 'Hiace (17 seats)' });
  await expect(page.getByText('17 seats. Tap or drag')).toBeVisible();
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('heading', { name: 'Maya Van' })).toBeVisible();

  // Route with a stop in between and its own price.
  await page.goto('/driver/routes');
  await page.getByRole('button', { name: 'Add route' }).click();
  await page.getByLabel('Starting point *').fill('Kathmandu ' + id);
  await page.getByLabel('Ending point *').fill('Pokhara ' + id);
  await page.getByLabel('Distance (km) *').fill('200');
  await page.getByLabel('Travel time (minutes) *').fill('420');
  await page.getByLabel('Price, start to end (NPR) *').fill('1200');
  await page.getByRole('button', { name: 'Add stop' }).click();
  await page.getByLabel('Stop 1 *').fill('Mugling ' + id);
  await page.getByLabel('Minutes after start *').fill('210');
  await page.getByLabel('Km from start *').fill('110');
  await page.getByLabel(`Kathmandu ${id} → Mugling ${id} (NPR)`).fill('700');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('heading', { name: `Kathmandu ${id} → Pokhara ${id}` })).toBeVisible();

  // Payment account.
  await page.goto('/driver/payment');
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.getByLabel('Bank or wallet name *').fill('eSewa');
  await page.getByLabel('Account holder *').fill(name);
  await page.getByLabel('Payment instructions for passengers *').fill('Scan the QR and add your booking reference.');
  await page.getByLabel('Payment QR image *').setInputFiles(await picture('#111111'));
  await expect(page.getByAltText('Uploaded')).toBeVisible();
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('heading', { name: 'eSewa' })).toBeVisible();

  // Nothing can be scheduled before approval.
  await page.goto('/driver/schedule');
  await expect(page.getByText('Before you can schedule a trip')).toBeVisible();
  await signOut(page);

  // Admin sees what was asked for, including the seat picture, and approves.
  await signIn(page, 'ADMIN', adminEmail, adminPassword);
  await page.goto('/admin/driver-requests');
  await expect(page.getByText('Seat plan: 17 seats')).toBeVisible();
  await expect(page.getByText(number, { exact: true })).toBeVisible();
  await approveAll(page, name, 3);
  await signOut(page);

  // The driver opens a trip at the approved price.
  await signIn(page, 'DRIVER', email, password);
  await page.goto('/driver/schedule');
  await page.getByLabel('Vehicle *').selectOption({ index: 1 });
  await page.getByLabel('Route *').selectOption({ index: 1 });
  await page.getByLabel('Payment account *').selectOption({ index: 1 });
  await expect(page.getByText(/Price per seat: Rs\. 1,200/)).toBeVisible();
  const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('Departure (Nepal time) *').fill(day + 'T07:00');
  await page.getByRole('button', { name: 'Open trip for booking' }).click();
  await expect(page.getByRole('status')).toContainText('open for booking');
  await expect(page.getByRole('heading', { name: `Kathmandu ${id} → Pokhara ${id}` })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  // Passengers can find it.
  await signOut(page);
  const search = await page.request.get('/api/trips?origin=' + encodeURIComponent('Kathmandu ' + id));
  expect(JSON.stringify(await search.json())).toContain(number);
});

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
  await expect(page.getByText('17 seats. Tap or drag')).toBeVisible();

  // Erasing one seat and auto-labelling the rest proves painting reaches the saved draft.
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.getByRole('gridcell', { name: /Row 2, column 1: seat/ }).click();
  await expect(page.getByText('16 seats. Tap or drag')).toBeVisible();
  await page.getByRole('button', { name: 'Auto-label seats' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.reload();
  await expect(page.getByText('16 seats. Tap or drag')).toBeVisible();
  await page.getByRole('button', { name: 'Publish version' }).click();
  await expect(page.getByRole('status')).toContainText('published');
});

test('only the admin uses the approval API, and the operator role is gone', async ({ page, request }) => {
  await signIn(page, 'DRIVER', 'driver@sajiloyatra.com', 'SajiloDriver@2026!');
  expect((await page.request.get('/api/admin/driver-submissions')).status()).toBe(403);
  expect((await request.get('/api/admin/driver-submissions')).status()).toBe(401);
  expect((await request.get('/api/operator/trips')).status()).toBe(404);
  expect((await page.request.get('/api/operator/driver-submissions')).status()).toBe(404);
  const login = await request.post('/api/auth/login', {
    data: { role: 'OPERATOR', email: 'driver@sajiloyatra.com', password: 'SajiloDriver@2026!' },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(login.status()).toBe(400);
});
