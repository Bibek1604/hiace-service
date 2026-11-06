import { test, expect } from '@playwright/test';

// Hydration mismatches and runtime exceptions show up as console errors; the public pages must have none.
for (const path of ['/', '/search?origin=&destination=&date=', '/track-booking', '/staff/sign-in', '/booking/unknown']) {
  test(`no console or hydration errors on ${path}`, async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    const response = await page.goto(path);
    expect(response?.status()).toBeLessThan(500);
    await page.waitForLoadState('networkidle');
    // Give React a moment to report hydration problems, which are logged after hydration completes.
    await page.waitForTimeout(500);
    // The browser itself logs every non-2xx fetch (e.g. the expected 404 for an unknown booking); only script errors count.
    const ignore = /favicon|manifest|service worker|sw\.js|Failed to load resource/i;
    const relevant = problems.filter((p) => !ignore.test(p));
    expect(relevant, relevant.join('\n')).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
