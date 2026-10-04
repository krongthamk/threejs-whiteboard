import { expect, test, type Page } from '@playwright/test';
import type { BoardConnection } from '../../packages/app/src/collaboration';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime; whiteboardConnection?: BoardConnection } }
const password = 'browser-test-only-password';
async function signIn(page: Page, username: string, path = '/') {
  await page.goto(path);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function connected(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
}
const read = (page: Page, id: string) => page.evaluate(id => window.whiteboard.board.read(id), id);

test('F1.1 authenticated shape labels persist, undo once and merge with a peer move', async ({ browser }) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [alice, bob, fresh] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = []; for (const page of [alice!, bob!, fresh!]) page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(alice!, 'alice');
    await expect(alice!.getByRole('button', { name: 'New board', exact: true })).toBeVisible();
    await alice!.getByRole('button', { name: 'New board', exact: true }).click();
    await alice!.getByLabel('Board name', { exact: true }).fill('F1.1 model persistence');
    await alice!.getByRole('button', { name: 'Create board', exact: true }).click(); await connected(alice!);
    const path = new URL(alice!.url()).pathname;
    const boardId = path.split('/').at(-1)!;
    await alice!.getByRole('button', { name: 'Share', exact: true }).click();
    await alice!.getByLabel('Username', { exact: true }).fill('bob');
    await alice!.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(alice!.getByText('Access granted to bob.', { exact: true })).toBeVisible();
    await alice!.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await signIn(bob!, 'bob', path); await connected(bob!);
    const created = await alice!.evaluate(() => {
      const board = window.whiteboard.board;
      const rect = board.create('rect', { id: 'model-rect', x: 10, y: 20, w: 200, h: 100 });
      const ellipse = board.create('ellipse', { id: 'model-ellipse', x: 240, y: 20, w: 140, h: 80 });
      board.undoManager.clear(); board.setShapeText(rect.id, 'Stored 日本語');
      return { rect, ellipse, undoSteps: board.undoManager.undoStack.length };
    });
    expect(created.undoSteps).toBe(1);
    const initialProps = { text: 'Stored 日本語', align: 'center', autoSize: false, verticalAlign: 'middle' };
    await expect.poll(async () => (await read(bob!, created.rect.id))?.props).toEqual(initialProps);
    await alice!.evaluate(() => window.whiteboard.board.undoManager.undo());
    await expect.poll(async () => (await read(bob!, created.rect.id))?.props).toEqual({});
    expect(await read(alice!, created.rect.id)).toEqual(created.rect);
    await alice!.evaluate(() => window.whiteboard.board.undoManager.redo());
    await expect.poll(async () => (await read(bob!, created.rect.id))?.props).toEqual(initialProps);

    // Wait for actual socket closure before making independent offline writes.
    for (const page of [alice!, bob!]) {
      await page.evaluate(() => window.whiteboardConnection!.provider.disconnect());
      await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    }
    await alice!.evaluate(() => {
      const board = window.whiteboard.board; board.undoManager.clear();
      board.setShapeText('model-rect', 'Concurrent label');
      board.update('model-ellipse', { props: { text: 'Ellipse label', align: 'right', autoSize: false, verticalAlign: 'bottom' } });
    });
    await bob!.evaluate(() => { const board = window.whiteboard.board; board.undoManager.clear(); board.move(['model-rect'], { x: 35, y: -7 }); });
    await Promise.all([alice!, bob!].map(page => page.evaluate(() => window.whiteboardConnection!.provider.connect())));
    await connected(alice!); await connected(bob!);
    const expectedRect = { ...created.rect, x: 45, y: 13, props: { ...initialProps, text: 'Concurrent label' } };
    const expectedEllipse = { ...created.ellipse, props: { text: 'Ellipse label', align: 'right', autoSize: false, verticalAlign: 'bottom' } };
    for (const page of [alice!, bob!]) {
      await expect.poll(() => read(page, created.rect.id)).toEqual(expectedRect);
      await expect.poll(() => read(page, created.ellipse.id)).toEqual(expectedEllipse);
    }
    const undoCount = await bob!.evaluate(() => window.whiteboard.board.undoManager.undoStack.length); expect(undoCount).toBe(1);
    await bob!.evaluate(() => window.whiteboard.board.undoManager.undo());
    await expect.poll(() => read(alice!, created.rect.id)).toEqual({ ...expectedRect, x: 10, y: 20 });
    await bob!.evaluate(() => window.whiteboard.board.undoManager.redo());
    await expect.poll(() => read(alice!, created.rect.id)).toEqual(expectedRect);

    // Positive SQL log evidence plus a new context avoids reloading solely from IndexedDB.
    await expect.poll(() => alice!.evaluate(async boardId => {
      const response = await fetch('/api/metrics'); const metrics = await response.json();
      return metrics.boards.find((board: { boardId: string }) => board.boardId === boardId)?.storage.updateCount ?? 0;
    }, boardId)).toBeGreaterThan(0);
    await contexts[0]!.close(); await contexts[1]!.close();
    await signIn(fresh!, 'alice', path); await connected(fresh!);
    expect(await read(fresh!, created.rect.id)).toEqual(expectedRect);
    expect(await read(fresh!, created.ellipse.id)).toEqual(expectedEllipse);
    await fresh!.reload(); await connected(fresh!);
    expect(await read(fresh!, created.rect.id)).toEqual(expectedRect);
    expect(await fresh!.evaluate(() => window.whiteboard.board.meta.get('schemaVersion'))).toBe(2);
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
