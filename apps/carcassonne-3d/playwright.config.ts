import { defineConfig } from '@playwright/test';

/**
 * Runner configuration only: it connects to an already-running app and does not
 * start a server or launch a browser outside Playwright's configured runner.
 * Visible product acceptance must additionally use the Host-selected browser.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.CARCASSONNE_BASE_URL ?? 'http://127.0.0.1:5188',
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
});
