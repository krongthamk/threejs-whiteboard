import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const testPort = Number(process.env.WHITEBOARD_TEST_PORT ?? 3001);
if (!Number.isInteger(testPort) || testPort < 1 || testPort > 65535) throw new Error('WHITEBOARD_TEST_PORT must be an integer from 1 to 65535.');

export default defineConfig({
  testDir: './tests/app',
  outputDir: fileURLToPath(new URL('./test-results/app/', import.meta.url)),
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: fileURLToPath(new URL('./playwright-report/app/', import.meta.url)), open: 'never' }]],
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
    url: `http://127.0.0.1:${testPort}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: 'VITE_TEST_HOOKS=1 pnpm --filter @whiteboard/app build && pnpm --filter @whiteboard/app preview',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 60_000,
  }],
});
