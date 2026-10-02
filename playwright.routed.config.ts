import { defineConfig } from '@playwright/test';
import base from './playwright.app.config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  ...base,
  testDir: './tests/routed',
  outputDir: fileURLToPath(new URL('./test-results/routed/', import.meta.url)),
  reporter: [['list'], ['html', { outputFolder: fileURLToPath(new URL('./playwright-report/routed/', import.meta.url)), open: 'never' }]],
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => index === 0
    ? { ...server, command: `WHITEBOARD_TEST_SHARDS=2 ${server.command}` }
    : server),
});
