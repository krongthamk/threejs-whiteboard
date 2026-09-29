import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/app',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/app', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--enable-webgl', '--ignore-gpu-blocklist'] },
  },
  webServer: [{
    command: 'pnpm exec tsx scripts/app-test-server.ts',
    url: 'http://127.0.0.1:3001/health',
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: 'VITE_TEST_HOOKS=1 pnpm --filter @whiteboard/app build && pnpm --filter @whiteboard/app preview',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 60_000,
  }],
});
