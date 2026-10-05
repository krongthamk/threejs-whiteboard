import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/demo',
  outputDir: './test-results/demo',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/demo', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5176', channel: 'chrome',
    viewport: { width: 1440, height: 1000 }, headless: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { args: ['--enable-webgl', '--ignore-gpu-blocklist'] },
  },
  // Deliberately no backend process: this is also a check against accidental API dependencies.
  webServer: {
    command: 'VITE_DEMO=1 VITE_TEST_HOOKS=1 pnpm --filter @whiteboard/app build && pnpm --filter @whiteboard/app exec vite preview --host 127.0.0.1 --port 5176 --strictPort',
    url: 'http://127.0.0.1:5176', reuseExistingServer: false, timeout: 60_000,
  },
});
