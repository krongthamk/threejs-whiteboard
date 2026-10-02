import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: './tests/browser',
  outputDir: fileURLToPath(new URL('./test-results/browser/', import.meta.url)),
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: fileURLToPath(new URL('./playwright-report/browser/', import.meta.url)), open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    viewport: { width: 1440, height: 900 },
    browserName: 'chromium',
    channel: 'chrome',
    launchOptions: { args: ['--enable-webgl', '--ignore-gpu-blocklist'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build:spikes && pnpm preview:spikes',
    url: 'http://127.0.0.1:4175/text/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
