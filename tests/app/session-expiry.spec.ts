import { test, expect, type Page } from '@playwright/test';
import type { BoardConnection } from '../../packages/app/src/collaboration';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime; whiteboardConnection?: BoardConnection } }
const password = 'browser-test-only-password';
async function login(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function connected(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
}

for (const reason of ['session-expired', 'session-revoked']) {
  test(`${reason} returns to sign-in and preserves the board URL, cache epoch and queued work`, async ({ page, browser }) => {
    await page.goto('/'); await login(page);
    const back = page.getByRole('button', { name: 'Back to boards', exact: true });
    await expect(back.or(page.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
    if (await back.isVisible()) await back.click();
    await page.getByRole('button', { name: 'New board', exact: true }).click();
    await page.getByLabel('Board name', { exact: true }).fill(`Retained ${reason}`);
    await page.getByRole('button', { name: 'Create board', exact: true }).click(); await connected(page);
    const path = new URL(page.url()).pathname;
    const cache = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json() as { user: { id: string } };
      const boardId = location.pathname.split('/').at(-1)!;
      const key = `whiteboard:${session.user.id}:${boardId}:cache-epoch`;
      window.whiteboardConnection!.provider.disconnect();
      window.whiteboard.board.create('rect', { id: 'queued-before-expiry', x: 140, y: 180, w: 160, h: 90 });
      // A readonly transaction queues behind the actual Yjs persistence write.
      await new Promise<void>((resolve, reject) => {
        const transaction = window.whiteboardConnection!.persistence.db!.transaction('updates', 'readonly');
        transaction.objectStore('updates').getAll(); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
      return { key, epoch: localStorage.getItem(key), boardId };
    });
    expect(await page.evaluate(async () => (await fetch('/api/session/logout', { method: 'POST' })).status)).toBe(204);
    // The disconnected replica cannot receive a server reset. Exercise the
    // expiry/revocation hook while its HTTP session is genuinely unauthorized.
    await page.evaluate(({ reason, boardId }) => window.whiteboardConnection!.provider.configuration.onStateless({
      payload: JSON.stringify({ type: 'permission-changed', boardId, role: null, resetRequired: true, reason }),
    }), { reason, boardId: cache.boardId });
    expect.soft(await page.evaluate(key => localStorage.getItem(key), cache.key)).toBe(cache.epoch);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    await login(page); await connected(page);
    expect(new URL(page.url()).pathname).toBe(path);
    expect(await page.evaluate(key => localStorage.getItem(key), cache.key)).toBe(cache.epoch);
    await expect.poll(() => page.evaluate(() => window.whiteboard.board.read('queued-before-expiry')?.type)).toBe('rect');
    await page.waitForFunction(() => !window.whiteboardConnection!.provider.hasUnsyncedChanges);
    // A fresh browser has no IndexedDB cache: seeing the edit proves replay
    // reached the server after authenticating again as the original account.
    const observer = await browser.newContext();
    try {
      await observer.addCookies(await page.context().cookies());
      const fresh = await observer.newPage(); await fresh.goto(page.url()); await connected(fresh);
      expect(await fresh.evaluate(() => window.whiteboard.board.read('queued-before-expiry')?.type)).toBe('rect');
    } finally { await observer.close(); }
    await page.reload(); await connected(page);
    expect(await page.evaluate(() => window.whiteboard.board.read('queued-before-expiry')?.type)).toBe('rect');
  });
}
