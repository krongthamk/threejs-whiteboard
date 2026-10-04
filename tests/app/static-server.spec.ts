import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhiteboardServer } from '../../packages/server/src/server';

const password = 'static-browser-test-password';
let server: ReturnType<typeof createWhiteboardServer>, directory: string, origin: string, boardId: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'whiteboard-static-browser-'));
  server = createWhiteboardServer({ databasePath: join(directory, 'board.sqlite'), assetDirectory: join(directory, 'assets'),
    sessionSecret: 'static-browser-secret-with-at-least-thirty-two-characters', port: 0,
    staticDirectory: fileURLToPath(new URL('../../packages/app/dist/', import.meta.url)) });
  const owner = server.store.createUser('static-owner', password), editor = server.store.createUser('static-editor', password);
  const board = server.store.createBoard(owner.id, 'Static original'); boardId = board.id; server.store.setMember(board.id, editor.id, 'editor');
  await server.listen(); origin = `http://127.0.0.1:${server.port}`;
});
test.afterAll(async () => { await server?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
async function signIn(page: Page, username: string) {
  await page.goto(`${origin}/board/${boardId}`);
  await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
}

test('production CSP permits live titles, local text/image workers and all export formats', async ({ page, browser }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.assign(window, { cspViolations: [] as string[] });
    document.addEventListener('securitypolicyviolation', event => {
      (window as unknown as { cspViolations: string[] }).cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  const second = await browser.newContext(), collaborator = await second.newPage();
  try {
    await signIn(page, 'static-owner'); await signIn(collaborator, 'static-editor');
    await page.getByRole('button', { name: 'Rename board', exact: true }).click();
    await page.getByLabel('Board name', { exact: true }).fill('Static live title'); await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Static live title', exact: true })).toBeVisible();
    await expect(collaborator.getByRole('heading', { name: 'Static live title', exact: true })).toBeVisible();
    await collaborator.getByRole('button', { name: 'Rename board', exact: true }).click();
    await expect(collaborator.getByLabel('Board name', { exact: true })).toHaveValue('Static live title');
    await collaborator.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
      canvas.getContext('2d')!.fillRect(0, 0, 40, 30);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      await window.whiteboard.assets.importFiles([new File([blob], 'fixture.png', { type: 'image/png' })]);
      window.whiteboard.board.create('text', { x: -200, y: -80, props: { text: 'Static CSP 日本語', align: 'left', autoSize: true } });
      window.whiteboard.controller.zoomToFit(); await window.whiteboard.renderer.whenReady();
    });
    expect(await page.evaluate(() => window.whiteboard.renderer.stats().visibleImages)).toBe(1);
    for (const format of ['png', 'svg', 'pdf'] as const) {
      await page.getByRole('button', { name: 'Export board', exact: true }).click();
      await page.getByRole('button', { name: format === 'png' ? 'PNG Image' : format === 'svg' ? 'SVG Scalable vector' : 'PDF Document', exact: true }).click();
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: `Download ${format.toUpperCase()}`, exact: true }).click();
      const download = await pending; expect(download.suggestedFilename()).toBe(`Static live title.${format}`);
      const artifact = testInfo.outputPath(`static.${format}`); await download.saveAs(artifact); const bytes = readFileSync(artifact);
      expect(bytes.length).toBeGreaterThan(100);
      if (format === 'png') expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      if (format === 'svg') { expect(bytes.toString()).toContain('Static live title'); expect(bytes.toString()).toContain('data:image/png'); }
      if (format === 'pdf') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
    expect(errors).toEqual([]);
    await collaborator.reload(); await expect(collaborator.getByRole('heading', { name: 'Static live title', exact: true })).toBeVisible();
  } finally { await second.close(); }
});
