import { defineConfig, devices } from '@playwright/test';

/**
 * Real browser engines on phone, tablet and desktop profiles: WebKit stands in for iPhone Safari and
 * Chromium for Android Chrome. Run against a production build on a disposable database, because the
 * tests create bookings:
 *   E2E_BASE_URL=http://localhost:3310 npx playwright test -c playwright.devices.config.ts
 */
export default defineConfig({
  testDir: './tests/devices',
  timeout: 120000,
  workers: 2,
  reporter: 'list',
  use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000', trace: 'retain-on-failure', actionTimeout: 20000 },
  projects: [
    { name: 'iphone-se', use: { ...devices['iPhone SE'] } },
    { name: 'iphone-15-max', use: { ...devices['iPhone 15 Pro Max'] } },
    { name: 'iphone-landscape', use: { ...devices['iPhone 13 landscape'] } },
    { name: 'android-small', use: { ...devices['Galaxy S9+'] } },
    { name: 'android-pixel', use: { ...devices['Pixel 7'] } },
    { name: 'ipad', use: { ...devices['iPad Mini'] } },
    { name: 'laptop', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
  ],
});
