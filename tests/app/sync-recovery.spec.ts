import { test, expect } from '@playwright/test';
import type { EditorRuntime } from '../../packages/app/src/runtime';
import type { BoardConnection } from '../../packages/app/src/collaboration';

declare global { interface Window { whiteboard: EditorRuntime; whiteboardConnection?: BoardConnection } }

test('a retained oversized replica survives reload and exports before explicit discard', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const back = page.getByRole('button', { name: 'Back to boards', exact: true });
  await expect(back.or(page.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Retained recovery');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await page.evaluate(() => {
    const connection = window.whiteboardConnection!;
    connection.provider.disconnect();
    window.whiteboard.board.create('rect', { id: 'local-only', x: -100, y: -100 });
    // Deliver the real provider's stateless event; the server's resource tests
    // separately prove this exact refusal envelope precedes its document close.
    connection.provider.receiveStateless(JSON.stringify({ type: 'sync-rejected', boardId: connection.provider.configuration.name,
      reason: 'update-too-large', retryable: false, maxBytes: 4 * 1024 * 1024 }));
  });
  const notice = page.getByRole('status', { name: 'Board data notice' });
  await expect(notice).toContainText('pending changes exceed');
  await expect(page.getByRole('button', { name: 'Rectangle', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry sync', exact: true })).toHaveCount(0);
  // Ensure the update is durable before navigating away from its current Doc.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const transaction = window.whiteboardConnection!.persistence.db!.transaction('updates', 'readonly');
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  }));
  await page.reload();
  await expect(notice).toContainText('local work is kept on this device');
  expect(await page.evaluate(() => window.whiteboard.board.read('local-only')?.id)).toBe('local-only');
  await page.getByRole('button', { name: 'Export local work', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const svg = await page.evaluate(async () => (await window.whiteboard.exporter.create({ format: 'svg', scale: 1, transparent: true, title: 'Local recovery' })).text());
  expect(svg).toContain('data-element-id="local-only"');
  await page.getByRole('button', { name: 'Discard local changes and reopen', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Unsynced changes on this device will be permanently discarded');
  await page.getByRole('button', { name: 'Keep local changes', exact: true }).click();
  expect(await page.evaluate(() => window.whiteboard.board.read('local-only')?.id)).toBe('local-only');
  await page.getByRole('button', { name: 'Discard local changes and reopen', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and reopen saved board', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  expect(await page.evaluate(() => window.whiteboard.board.read('local-only'))).toBeUndefined();
  await expect(notice).toHaveCount(0);
});
