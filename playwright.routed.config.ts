import { defineConfig } from '@playwright/test';
import base from './playwright.app.config';

export default defineConfig({
  ...base,
  testDir: './tests/routed',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/routed', open: 'never' }]],
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => index === 0
    ? { ...server, command: `WHITEBOARD_TEST_SHARDS=2 ${server.command}` }
    : server),
});
