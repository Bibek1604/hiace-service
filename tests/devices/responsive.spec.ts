import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ApiClient, adminCredentials, seedScenario, type Scenario } from '../fixtures/api-client';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
let s: Scenario;
let heldBooking: { id: string; cookie: string };

test.beforeAll(async () => {
  s = await seedScenario(BASE);
  const guest = new ApiClient(BASE);
  const seats = await guest.get<{ seats: { id: string; state: string }[] }>('/api/trips/' + s.tripId);
  const seat = seats.data.seats.find((x) => x.state === 'AVAILABLE')!;
  const held = await guest.post<{ id: string }>('/api/bookings', {
    tripId: s.tripId,
    seats: [seat.id],
    name: 'Device Check',
    phone: '9841000099',
    idempotencyKey: randomUUID() + randomUUID(),
  });
  heldBooking = { id: held.data.id, cookie: guest.jar.get('booking_' + held.data.id)! };
});

/** Production cookies are Secure, which WebKit refuses on http://localhost even though the site is HTTPS when live. */
async function allowSessionOnLocalhost(context: BrowserContext) {
  await context.route('**/api/**', async (route) => {
    const response = await route.fetch();
    const headers = response.headersArray().map((h) =>
      h.name.toLowerCase() === 'set-cookie' ? { ...h, value: h.value.replace(/;\s*secure/i, '') } : h,
    );
    await route.fulfill({ response, headers: Object.fromEntries(headers.map((h) => [h.name, h.value])) });
  });
}

async function signIn(context: BrowserContext, role: 'ADMIN' | 'DRIVER') {
  const client = new ApiClient(BASE);
  const creds = role === 'ADMIN' ? adminCredentials() : { email: s.driver.email, password: s.driver.password };
  const r = await client.login(role, creds.email, creds.password);
  expect(r.status).toBe(200);
  const host = new URL(BASE).hostname;
  await context.addCookies([...client.jar].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' as const })));
}

/** Everything that makes a page awkward on a device, as a list of readable problems. */
async function layoutProblems(page: Page, touch: boolean) {
  return page.evaluate((isTouch) => {
    const width = document.documentElement.clientWidth;
    const problems: string[] = [];
    const describe = (el: Element) => el.tagName.toLowerCase() + ' "' + (el.textContent ?? '').trim().slice(0, 30) + '"';
    const visible = (el: Element) => {
      const style = getComputedStyle(el),
        box = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    const scrolls = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
        if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(p).overflowX)) return true;
      return false;
    };
    if (document.documentElement.scrollWidth > width) problems.push('page scrolls sideways');
    for (const el of document.querySelectorAll('main *, .staff-content *, footer *, header *')) {
      if (!visible(el) || el.closest('svg')) continue;
      const box = el.getBoundingClientRect();
      if ((box.right > width + 1 || box.left < -1) && !scrolls(el)) problems.push('off screen: ' + describe(el));
    }
    if (isTouch)
      for (const el of document.querySelectorAll('input, select, textarea, .button')) {
        if (!visible(el)) continue;
        const type = el.getAttribute('type') ?? '';
        if (['checkbox', 'radio', 'file', 'hidden'].includes(type)) continue;
        if (el.matches('input, select, textarea') && parseFloat(getComputedStyle(el).fontSize) < 16)
          problems.push('field zooms on iPhone: ' + describe(el));
        if (el.getBoundingClientRect().height < 40) problems.push('target too small: ' + describe(el));
      }
    return problems.slice(0, 8);
  }, touch);
}

const isPhone = (page: Page) => page.viewportSize()!.width < 768;
const isTouch = (page: Page) => page.viewportSize()!.width < 1100;
async function settle(page: Page) {
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 15000 });
}

test('public pages fit the screen', async ({ page }) => {
  for (const url of ['/', '/search', '/trips/' + s.tripId, '/track-booking', '/staff/sign-in', '/not-a-page']) {
    await page.goto(url);
    await settle(page);
    expect(await layoutProblems(page, isTouch(page)), url).toEqual([]);
  }
});

test('a long option cannot push a form past the screen edge', async ({ page, context }) => {
  await signIn(context, 'ADMIN');
  await page.goto('/admin/trips/new');
  await settle(page);
  const form = page.locator('form.admin-form');
  await expect(form).toBeVisible();
  expect(await form.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
});

test('the highlighted hero line is readable', async ({ page }) => {
  await page.goto('/');
  const colour = await page.locator('.hero h1 .blue').evaluate((el) => getComputedStyle(el).color);
  expect(colour).toBe('rgb(255, 217, 138)');
});

test('footer links stay on separate lines', async ({ page }) => {
  await page.goto('/');
  const find = await page.locator('.site-footer').getByRole('link', { name: 'Find a ride' }).boundingBox();
  const track = await page.locator('.site-footer').getByRole('link', { name: 'Track booking' }).boundingBox();
  expect(track!.y).toBeGreaterThanOrEqual(find!.y + find!.height - 1);
});

test('admin pages fit the screen and dates are real', async ({ page, context }) => {
  await signIn(context, 'ADMIN');
  for (const section of ['dashboard', 'reports', 'vehicles', 'drivers', 'locations', 'routes', 'fares', 'trips', 'bookings', 'payments', 'payment-qr', 'tickets', 'audit', 'website', 'settings', 'seat-layouts', 'seat-layouts/' + s.layoutId, 'routes/' + s.routeId, 'vehicles/' + s.vehicleId, 'trips/new']) {
    await page.goto('/admin/' + section);
    await settle(page);
    expect(await layoutProblems(page, isTouch(page)), section).toEqual([]);
    await expect(page.locator('body')).not.toContainText('Invalid Date');
  }
});

test('driver pages fit the screen', async ({ page, context }) => {
  await signIn(context, 'DRIVER');
  for (const section of ['/bookings', '/profile', '/vehicles', '/routes', '/payment', '/schedule', '/history', '/trips', '/trips/' + s.tripId, '/passengers']) {
    await page.goto('/driver' + section);
    await settle(page);
    expect(await layoutProblems(page, isTouch(page)), section).toEqual([]);
  }
});

test('phones get bottom tabs, and every section is reachable from More', async ({ page, context }) => {
  test.skip(!isPhone(page), 'phone navigation');
  await signIn(context, 'DRIVER');
  await page.goto('/driver/bookings');
  const tabs = page.locator('.staff-tabs');
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('link', { name: /^bookings$/i })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Publish' }).click();
  await expect(page).toHaveURL(/\/driver\/schedule/);
  await tabs.getByRole('button', { name: 'More' }).click();
  const sheet = page.getByRole('dialog');
  for (const name of [/^profile$/i, /^vehicles$/i, /^routes$/i, /^payment$/i, /^history$/i]) await expect(sheet.getByRole('link', { name })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await sheet.getByRole('link', { name: /^vehicles$/i }).click();
  await expect(page).toHaveURL(/\/driver\/vehicles/);
  await expect(sheet).toBeHidden();
});

test('bottom navigation never hides the end of a page', async ({ page }) => {
  test.skip(!isPhone(page), 'phone navigation');
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect
    .poll(() =>
      page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        return document.querySelector('.mobile-nav')!.getBoundingClientRect().top - document.querySelector('.copyright')!.getBoundingClientRect().bottom;
      }),
    )
    .toBeGreaterThanOrEqual(0);
});

test('tablets use an icon rail that keeps every section labelled', async ({ page, context }) => {
  test.skip(page.viewportSize()!.width !== 768, 'tablet width');
  await signIn(context, 'ADMIN');
  await page.goto('/admin/bookings');
  const rail = page.locator('.staff-shell aside');
  expect((await rail.boundingBox())!.width).toBeLessThan(90);
  await expect(rail.getByRole('link', { name: /^payments$/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Walk-in/ })).toBeInViewport();
});

test('a passenger can choose a seat by touch and hold it', async ({ page, context }) => {
  await allowSessionOnLocalhost(context);
  await page.goto('/trips/' + s.tripId);
  const seat = page.locator('button.seat.available').first();
  await seat.scrollIntoViewIfNeeded();
  const box = (await seat.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(40);
  if (isTouch(page) && (await page.evaluate(() => navigator.maxTouchPoints > 0))) await seat.tap();
  else await seat.click();
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByLabel('Passenger name').fill('Touch Passenger');
  await page.getByLabel('Mobile number').fill('9841234567');
  await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 0.4 });
  await page.getByRole('button', { name: /Hold seats/ }).click();
  await expect(page).toHaveURL(/\/booking\//);
  await settle(page);
  expect(await layoutProblems(page, isTouch(page))).toEqual([]);
});

test('a booking page fits, including the payment form', async ({ page, context }) => {
  await context.addCookies([{ name: 'booking_' + heldBooking.id, value: heldBooking.cookie, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/booking/' + heldBooking.id);
  await settle(page);
  await expect(page.getByLabel('Amount paid (NPR)')).toBeVisible();
  expect(await layoutProblems(page, isTouch(page))).toEqual([]);
});

test('the manifest is installable and allows any orientation', async ({ request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.orientation).toBe('any');
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
});

test.describe('installed app behaviour', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'service workers cannot be driven in Playwright WebKit');

  async function controlled(page: Page) {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  }

  test('offline pages show the offline screen, for private pages too, and nothing private is stored', async ({ page, context }) => {
    await signIn(context, 'DRIVER');
    await controlled(page);
    await page.goto('/driver/bookings');
    await settle(page);
    await context.setOffline(true);
    for (const url of ['/', '/driver/bookings', '/booking/' + heldBooking.id, '/search']) {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: /offline/i })).toBeVisible();
    }
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.locator('.header, .brand').first()).toBeVisible();
    const stored = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    expect(stored.filter((u) => /^\/(api|admin|driver|staff|booking|track-booking)/.test(u))).toEqual([]);
  });

  test('a new version waits until the person accepts it', async ({ page }, info) => {
    // Changes the real file the server sends, so it needs this checkout's server and only one runner at a time.
    test.skip(info.project.name !== 'laptop', 'one profile is enough');
    await controlled(page);
    const script = 'public/sw.js',
      original = await readFile(script, 'utf8');
    try {
      await writeFile(script, original + String.fromCharCode(10) + '// next version');
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
      const banner = page.getByRole('status').filter({ hasText: 'new version' });
      await expect(banner).toBeVisible();
      // Nothing changes until the person agrees: the old worker keeps control.
      expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
      const reloaded = page.waitForEvent('load');
      await banner.getByRole('button', { name: 'Update' }).click();
      await reloaded;
      await expect(banner).toBeHidden();
    } finally {
      await writeFile(script, original);
    }
  });
});
