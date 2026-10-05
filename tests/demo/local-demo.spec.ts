import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.waitForFunction(() => !!window.whiteboard);
  await expect(page.getByRole('status').filter({ hasText: /^Saved in this browser$/ })).toBeVisible();
}
async function draw(page: Page, name = 'Rectangle', x = 450, y = 350) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 130, y + 90, { steps: 4 }); await page.mouse.up();
}
const contents = (page: Page) => page.evaluate(() => window.whiteboard.board.readAll());

test('opens without auth or API calls, saves drawings and titles through reload', async ({ page }) => {
  const requests: string[] = [], sockets: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto('/'); await ready(page);
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await draw(page); await ready(page);
  const original = await contents(page);
  expect(original).toHaveLength(1);
  await page.getByRole('button', { name: 'Rename board' }).click();
  await page.getByLabel('Board name').fill('Local ideas');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: 'Local ideas', exact: true })).toBeVisible();
  await page.reload(); await ready(page);
  expect(await contents(page)).toEqual(original);
  await expect(page.getByRole('heading', { name: 'Local ideas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to boards' }).click();
  await expect(page.getByRole('heading', { name: 'Local ideas', exact: true })).toBeVisible();
  expect(requests).toEqual([]); expect(sockets).toEqual([]);
});

test('anonymous tabs merge edits, show presence, and keep undo scoped to its tab', async ({ page, context }) => {
  await page.goto('/'); await ready(page);
  const peer = await context.newPage(); await peer.goto(page.url()); await ready(peer);
  await expect(page.locator('.peer-avatar')).toHaveCount(1);
  await expect(peer.locator('.peer-avatar')).toHaveCount(1);
  await Promise.all([draw(page), draw(peer, 'Ellipse', 700, 400)]);
  await expect.poll(async () => (await contents(page)).length).toBe(2);
  await expect.poll(async () => (await contents(peer)).length).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await contents(peer)).map(element => element.type)).toEqual(['ellipse']);
  await ready(peer); await peer.close();
  await expect(page.locator('.peer-avatar')).toHaveCount(0);
  await page.reload(); await ready(page);
  expect((await contents(page)).map(element => element.type)).toEqual(['ellipse']);
});

test('images persist and appear in another tab without uploading anywhere', async ({ page, context }) => {
  await page.goto('/'); await ready(page);
  const peer = await context.newPage(); await peer.goto(page.url()); await ready(peer);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
    canvas.getContext('2d')!.fillRect(0, 0, 40, 30);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    await window.whiteboard.assets.importFiles([new File([blob], 'demo.png', { type: blob.type })]);
  });
  await expect.poll(async () => (await contents(peer)).filter(element => element.type === 'image').length).toBe(1);
  await ready(page); await peer.close(); await page.reload(); await ready(page);
  expect((await contents(page))[0]!.type).toBe('image');
  const asset = await page.evaluate(async () => {
    const element = window.whiteboard.board.readAll()[0]!;
    if (element.type !== 'image') throw new Error('Expected image');
    const stored = window.whiteboard.board.doc.getMap<{ bytes: Uint8Array; mimeType: string }>('demo-assets').get(element.props.assetId)!;
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(stored.bytes)], { type: stored.mimeType }));
    return { width: bitmap.width, height: bitmap.height };
  });
  expect(asset).toEqual({ width: 40, height: 30 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a board link cannot expose saved work to a different browser context', async ({ page, browser }) => {
  await page.goto('/'); await ready(page); await draw(page);
  const other = await browser.newContext(), guest = await other.newPage();
  try {
    await guest.goto(page.url());
    await expect(guest.getByRole('alert')).toContainText('not saved in this browser');
    await expect(guest.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(guest.getByLabel('Whiteboard canvas')).toHaveCount(0);
  } finally { await other.close(); }
});

test('a failed save is reported and retried with all pending changes', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      const transaction = original.apply(this, args);
      if (args[1] === 'readwrite') {
        queueMicrotask(() => transaction.abort());
        IDBDatabase.prototype.transaction = original;
      }
      return transaction;
    };
  });
  await draw(page);
  await expect(page.getByRole('alert')).toContainText('could not save');
  await expect(page.getByRole('status').filter({ hasText: /^Changes not saved$/ })).toBeVisible();
  await draw(page, 'Ellipse', 700, 400); await ready(page);
  await page.reload(); await ready(page);
  expect(await contents(page)).toHaveLength(2);
});

test('desktop and mobile demo controls fit and describe local collaboration', async ({ page }, testInfo) => {
  await page.goto('/'); await ready(page);
  await page.screenshot({ path: testInfo.outputPath('desktop.png') });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('will not share your work with other devices yet');
  await expect(page.getByRole('link', { name: 'Open another tab' })).toHaveAttribute('href', page.url());
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Whiteboard canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('mobile.png') });
});
