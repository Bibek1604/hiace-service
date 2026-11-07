import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';
import { adminCredentials } from '../fixtures/api-client';

/**
 * The whole business, in the browser, across all three panels: the admin creates a driver, the driver sets up
 * and publishes trips, passengers book a part of the route and pay, and the driver decides. Nothing is seeded
 * through the API. Set E2E_SERVER_LOG to the server's log file to also cover booking recovery by code.
 */
const admin = adminCredentials();
const picture = async (background: string, name = 'picture.png') => ({
  name,
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 240, height: 240, channels: 3, background } }).png().toBuffer(),
});
const nepalDay = (offset: number) => new Date(Date.now() + 20700000 + offset * 86400000).toISOString().slice(0, 10);
const shots = process.env.E2E_SHOTS;
const shot = async (page: Page, name: string, project: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}-${project}.png`, fullPage: true });
};
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

async function signIn(page: Page, role: 'ADMIN' | 'DRIVER', email: string, password: string) {
  await page.goto('/staff/sign-in?role=' + role);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(new RegExp('/' + role.toLowerCase() + '/'), { timeout: 20000 });
}

/** Each person gets their own browser, so no cookie is shared between the panels. */
async function person(browser: Browser, viewport: { width: number; height: number } | null | undefined, baseURL: string | undefined) {
  const context = await browser.newContext({ viewport: viewport ?? undefined, baseURL, acceptDownloads: true });
  return context.newPage();
}

async function book(page: Page, search: string, name: string, phone: string) {
  await page.goto('/search?' + search);
  await page.getByRole('link', { name: /Choose seats/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Your journey' })).toBeVisible();
  const seat = page.locator('button.seat.available').first();
  const label = (await seat.textContent())!.trim();
  await seat.click();
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByLabel('Passenger name').fill(name);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: /Hold seats/ }).click();
  await expect(page).toHaveURL(/\/booking\/[a-z0-9]+$/, { timeout: 20000 });
  const reference = (await page.getByRole('heading', { name: /^SY-[A-Z0-9]{12}$/ }).textContent())!.trim();
  return { label, reference };
}

async function pay(page: Page) {
  await page.getByLabel(/Payment screenshot/).setInputFiles(await picture('#336699', 'proof.png'));
  await page.getByLabel('Bank / wallet used').fill('eSewa');
  await page.locator('form:has(input[name=claimedAmount]) button[type=submit]').click();
  await expect(page).toHaveURL(/\/status$/, { timeout: 20000 });
  await expect(page.getByText('PAYMENT REVIEW', { exact: true })).toBeVisible();
}

test('admin, driver and passengers complete the whole journey in the browser', async ({ browser, baseURL, page: office }, info) => {
  test.setTimeout(180000);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const viewport = info.project.use.viewport;
  const place = { start: 'Kathmandu ' + id, mid: 'Mugling ' + id, end: 'Pokhara ' + id };
  const driverEmail = `maya-${id}@test.local`,
    driverPassword = 'Maya-password-' + id,
    number = 'BA ' + id;

  // 1. The admin creates the driver.
  await signIn(office, 'ADMIN', admin.email, admin.password);
  await office.goto('/admin/drivers/new');
  await office.getByLabel('Full name *').fill('Maya ' + id);
  await office.getByLabel('Staff email *').fill(driverEmail);
  await office.getByLabel(/^Password/).fill(driverPassword);
  await office.getByLabel('Mobile *').fill('9800000011');
  await office.getByLabel('License number *').fill('L-' + id);
  await office.getByLabel('License expiry *').fill('2036-01-01T10:00');
  await office.getByLabel('Emergency contact *').fill('9800000012');
  await office.getByRole('button', { name: 'Create' }).click();
  await expect(office.getByRole('status')).toContainText('Created');

  // An edit of a driver with no address or photo saves; those empty fields used to refuse the whole form.
  await office.getByLabel('Search drivers').fill(driverEmail);
  await office.getByRole('button', { name: 'Search', exact: true }).click();
  await office.getByRole('row', { name: new RegExp(driverEmail) }).getByRole('button', { name: 'Edit' }).click();
  await office.getByLabel('Mobile *').fill('9800000013');
  await office.getByRole('button', { name: 'Save changes' }).click();
  await expect(office.getByRole('status')).toContainText('Changes saved');

  // 2. The driver sets up a vehicle, a route with a stop and a leg price, and a payment QR.
  const driver = await person(browser, viewport, baseURL);
  await signIn(driver, 'DRIVER', driverEmail, driverPassword);
  await driver.goto('/driver/vehicles');
  await driver.getByRole('button', { name: 'Add vehicle' }).click();
  await driver.getByLabel('Vehicle name *').fill('Maya Van ' + id);
  await driver.getByLabel('Vehicle number *').fill(number);
  await driver.getByLabel('Vehicle type *').selectOption('Hiace');
  await driver.getByLabel('Emergency contact *').fill('9800000012');
  await driver.getByLabel('Vehicle photos').setInputFiles(await picture('#2266aa'));
  await expect(driver.getByAltText('Uploaded')).toBeVisible();
  await driver.getByLabel('Seat plan *').selectOption({ label: 'Hiace (17 seats)' });
  await driver.getByRole('button', { name: 'Add vehicle' }).click();
  await expect(driver.getByRole('heading', { name: 'Maya Van ' + id })).toBeVisible();

  await driver.goto('/driver/routes');
  await driver.getByRole('button', { name: 'Add route' }).click();
  await driver.getByLabel('Starting point *').fill(place.start);
  await driver.getByLabel('Ending point *').fill(place.end);
  await driver.getByLabel('Distance (km) *').fill('200');
  await driver.getByLabel('Travel time (hours) *').fill('7');
  await driver.getByLabel('Price, start to end (NPR) *').fill('1200');
  await driver.getByRole('button', { name: 'Add stop' }).click();
  await driver.getByLabel('Stop 1 *').fill(place.mid);
  await driver.getByLabel('Minutes after start *').fill('210');
  await driver.getByLabel('Km from start *').fill('110');
  await driver.getByLabel(`${place.start} → ${place.mid} (NPR)`).fill('700');
  await driver.getByRole('button', { name: 'Add route' }).click();
  await expect(driver.getByRole('heading', { name: `${place.start} → ${place.end}` })).toBeVisible();

  await driver.goto('/driver/payment');
  await driver.getByRole('button', { name: 'Add account' }).click();
  await driver.getByLabel('Bank or wallet name *').fill('eSewa');
  await driver.getByLabel('Account holder *').fill('Maya ' + id);
  await driver.getByLabel('Payment instructions for passengers *').fill('Scan the QR and add your booking reference.');
  await driver.getByLabel('Payment QR image *').setInputFiles(await picture('#111111'));
  await expect(driver.getByAltText('Uploaded')).toBeVisible();
  await driver.getByRole('button', { name: 'Add account' }).click();
  await expect(driver.getByRole('heading', { name: 'eSewa' })).toBeVisible();

  // 3. Morning and afternoon departures for three days: two schedules, six separate trips.
  await driver.goto('/driver/schedule');
  await driver.getByRole('tab', { name: 'Double trip' }).click();
  await driver.getByLabel('Start date *').fill(nepalDay(1));
  await driver.getByLabel('End date *').fill(nepalDay(3));
  for (const n of [0, 1]) {
    await driver.getByLabel('Route *').nth(n).selectOption({ index: 1 });
    await driver.getByLabel('Vehicle *').nth(n).selectOption({ index: 1 });
    await driver.getByLabel('Payment account *').nth(n).selectOption({ index: 1 });
  }
  await expect(driver.getByText('Preview: 6 separate trips')).toBeVisible();
  await driver.getByRole('button', { name: 'Publish schedule' }).click();
  await expect(driver.getByRole('status')).toContainText('6 trips published');
  await shot(driver, 'schedule', info.project.name);
  expect(await fits(driver), 'the schedule page fits the screen').toBe(true);

  // Publishing the same days again is refused, with a reason, and creates nothing.
  await driver.getByRole('button', { name: 'Publish schedule' }).click();
  await expect(driver.getByText('already has an overlapping trip')).toBeVisible();

  // 4. A passenger searches for part of the route and sees the same fare from search to payment.
  const passenger = await person(browser, viewport, baseURL);
  const search = new URLSearchParams({ origin: place.mid, destination: place.end, date: nepalDay(2) }).toString();
  await passenger.goto('/search?' + search);
  const card = passenger.locator('article.trip-card').first();
  await expect(card).toContainText(`${place.mid} → ${place.end}`);
  await expect(card).toContainText('Rs. 540');
  await shot(passenger, 'search', info.project.name);
  expect(await fits(passenger), 'search results fit the screen').toBe(true);
  const held = await book(passenger, search, 'Sita Passenger', '9841234567');
  await expect(passenger.getByRole('heading', { name: `${place.mid} → ${place.end}` })).toBeVisible();
  await expect(passenger.getByText('Rs. 540').first()).toBeVisible();
  await expect(passenger.locator('img.qr-image')).toBeVisible();
  await shot(passenger, 'payment', info.project.name);
  expect(await fits(passenger), 'the payment page fits the screen').toBe(true);

  // 5. The passenger pays and submits proof.
  await pay(passenger);

  // 6. The driver sees the proof and approves it.
  await driver.goto('/driver/bookings');
  const row = driver.locator('article').filter({ hasText: held.reference });
  await expect(row).toContainText('Sita Passenger');
  await expect(row.getByRole('link', { name: 'View payment proof' })).toBeVisible();
  await row.getByRole('button', { name: 'Approve payment' }).click();
  await driver.getByLabel('Bank or wallet reference').fill('ESEWA-' + id);
  await shot(driver, 'approve-dialog', info.project.name);
  await driver.getByLabel('I checked the actual transaction and confirm receipt.').check();
  await driver.getByRole('button', { name: 'Approve and confirm seats' }).click();
  await expect(driver.getByRole('status')).toContainText('seats confirmed');
  await expect(row.getByText('CONFIRMED', { exact: true })).toBeVisible();

  // 7. The passenger sees the confirmation and downloads a ticket for their own leg.
  await passenger.reload();
  await expect(passenger.getByText('CONFIRMED', { exact: true })).toBeVisible();
  const [download] = await Promise.all([passenger.waitForEvent('download'), passenger.getByRole('button', { name: 'Download ticket' }).click()]);
  const ticket = readFileSync((await download.path())!, 'utf8');
  expect(ticket).toContain(`${place.mid} → ${place.end}`);
  expect(ticket).toContain(held.reference);

  // The sold seat is taken on that leg, and still free on the earlier leg it does not use.
  const tripUrl = await driver.request
    .get('/api/driver/bookings')
    .then((r) => r.json())
    .then((rows: { reference: string; trip: { id: string } }[]) => '/trips/' + rows.find((b) => b.reference === held.reference)!.trip.id);
  await passenger.goto(tripUrl);
  await expect(passenger.getByRole('button', { name: `Seat ${held.label}, booked` })).toBeVisible();
  await shot(passenger, 'trip', info.project.name);
  await passenger.getByLabel('Drop-off stop').selectOption({ label: place.mid });
  await expect(passenger.getByRole('button', { name: `Seat ${held.label}, available` })).toBeVisible();
  await expect(passenger.getByText('Rs. 700').first()).toBeVisible();

  // A second passenger's proof is rejected: they are told why and the seat returns to sale.
  const second = await person(browser, viewport, baseURL);
  const taken = await book(second, search, 'Hari Passenger', '9851234567');
  await pay(second);
  await driver.goto('/driver/bookings');
  const other = driver.locator('article').filter({ hasText: taken.reference });
  await other.getByRole('button', { name: 'Reject & release seats' }).click();
  await driver.getByLabel('Reason for rejection').fill('No such transaction in my wallet.');
  await driver.getByRole('button', { name: 'Reject and release seats' }).click();
  await expect(driver.getByRole('status')).toContainText('rejected');
  await second.reload();
  await expect(second.getByText('REJECTED', { exact: true }).first()).toBeVisible();
  await expect(second.getByText('No such transaction in my wallet.')).toBeVisible();

  // Booking recovery on a new device, by reference, phone and one-time code.
  const logFile = process.env.E2E_SERVER_LOG;
  if (logFile) {
    const newDevice = await person(browser, viewport, baseURL);
    await newDevice.goto('/track-booking');
    await newDevice.getByLabel('Booking reference').fill(held.reference);
    await newDevice.getByLabel('Booking phone number').fill('9841234567');
    await newDevice.locator('main form button').first().click();
    await expect(newDevice.getByLabel('Verification code')).toBeVisible();
    await expect.poll(() => readFileSync(logFile, 'utf8').includes('code for ' + held.reference)).toBe(true);
    const code = [...readFileSync(logFile, 'utf8').matchAll(new RegExp('code for ' + held.reference + ': (\\d{6})', 'g'))].at(-1)![1];
    await newDevice.getByLabel('Verification code').fill(code);
    await newDevice.locator('main form button').first().click();
    await expect(newDevice).toHaveURL(/\/booking\/.+\/status$/, { timeout: 20000 });
    await expect(newDevice.getByText('CONFIRMED', { exact: true })).toBeVisible();
    await newDevice.context().close();
  }

  // 8. The admin monitors the same transaction everywhere.
  await office.goto('/admin/bookings');
  await office.getByLabel('Search bookings').fill(held.reference);
  await office.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(office.getByRole('cell', { name: held.reference })).toBeVisible();

  await office.goto('/admin/payments');
  await office.getByLabel('Filter by payment status').selectOption('VERIFIED');
  await office.getByLabel('Search payments').fill(held.reference);
  await office.getByRole('button', { name: 'Search', exact: true }).click();
  const payment = office.locator('article.payment-review').filter({ hasText: held.reference });
  await expect(payment).toBeVisible();
  await expect(payment.getByRole('button', { name: 'Verify payment' })).toHaveCount(0);

  await office.goto('/admin/payments');
  await office.getByLabel('Filter by payment status').selectOption('REJECTED');
  await office.getByLabel('Search payments').fill(taken.reference);
  await office.getByRole('button', { name: 'Search', exact: true }).click();
  const refused = office.locator('article.payment-review').filter({ hasText: taken.reference });
  await expect(refused).toBeVisible();
  await expect(refused.getByRole('button', { name: 'Verify payment' }), 'a rejected payment cannot be verified later').toHaveCount(0);

  await office.goto('/admin/dashboard');
  await expect(office.getByText('Verified revenue')).toBeVisible();

  // 9. The audit log names who did what.
  await office.goto('/admin/audit');
  await expect(office.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await shot(office, 'audit', info.project.name);
  await office.getByLabel('Search the audit log').fill('PAYMENT_VERIFY');
  await office.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(office.getByRole('row', { name: new RegExp('Driver: Maya ' + id) }).first()).toBeVisible();

  // Unauthorized access is refused across the board.
  await passenger.goto('/driver/bookings');
  await expect(passenger).toHaveURL(/staff\/sign-in/);
  await passenger.goto('/admin/dashboard');
  await expect(passenger).toHaveURL(/staff\/sign-in/);
  expect((await passenger.request.get('/api/admin/reports')).status()).toBe(401);
  expect((await driver.request.get('/api/admin/reports')).status()).toBe(403);
  expect((await office.request.get('/api/driver/bookings')).status()).toBe(403);
  await second.context().close();
  await passenger.context().close();
  await driver.context().close();
});

test('a driver cancels a booking, controls a trip to completion and manages seats on the screen', async ({ browser, baseURL, page: office }, info) => {
  test.setTimeout(240000);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { seedScenario } = await import('../fixtures/api-client');
  const s = await seedScenario(baseURL!);
  void office;
  void id;
  const driver = await person(browser, info.project.use.viewport, baseURL);
  await signIn(driver, 'DRIVER', s.driver.email, s.driver.password);

  const passenger = await person(browser, info.project.use.viewport, baseURL);
  const search = new URLSearchParams({ origin: s.names.origin, destination: s.names.dest }).toString();
  const held = await book(passenger, search, 'Gita Passenger', '9861234567');

  await driver.goto('/driver/bookings?tripId=' + s.tripId);
  await expect(driver.getByRole('heading', { name: 'Live seat availability' })).toBeVisible();

  // A free seat can be blocked for this departure; a reserved one cannot.
  await driver.getByText('Block or unblock seats on this departure').click();
  await expect(driver.getByRole('button', { name: `Seat ${held.label}, reserved` })).toBeDisabled();
  const free = driver.getByRole('button', { name: /^Seat [^,]+$/ }).first();
  const label = (await free.getAttribute('aria-label'))!.replace('Seat ', '');
  await free.click();
  await driver.getByLabel('Reason').fill('Broken seat belt');
  await driver.getByRole('button', { name: 'Block seat' }).click();
  await expect(driver.getByRole('button', { name: `Seat ${label}, blocked` })).toBeVisible();

  // Cancelling releases the seat and the passenger sees it.
  const row = driver.locator('article').filter({ hasText: held.reference });
  await row.getByRole('button', { name: 'Cancel booking' }).click();
  await driver.getByLabel('Reason').fill('Passenger phoned to cancel');
  await driver.locator('.sheet').getByRole('button', { name: 'Cancel booking' }).click();
  await expect(driver.getByRole('status')).toContainText('was cancelled');
  await passenger.reload();
  await expect(passenger.getByText('CANCELLED', { exact: true })).toBeVisible();

  // Trip lifecycle through to completion.
  const trip = driver.locator('.card').filter({ has: driver.getByRole('button', { name: 'Start boarding' }) }).first();
  await trip.getByRole('button', { name: 'Start boarding' }).click();
  await expect(trip.getByRole('button', { name: 'Depart' })).toBeEnabled();
  await trip.getByRole('button', { name: 'Depart' }).click();
  await expect(trip.getByRole('button', { name: 'Complete trip' })).toBeEnabled();
  await trip.getByRole('button', { name: 'Complete trip' }).click();
  await expect(trip.getByText('COMPLETED', { exact: true })).toBeVisible();
  await expect(trip.getByRole('button', { name: 'Complete trip' })).toBeDisabled();
  await passenger.context().close();
  await driver.context().close();
});
