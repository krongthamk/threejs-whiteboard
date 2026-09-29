import { test, expect, type Page } from '@playwright/test';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const board = window.whiteboard.board;
    board.create('sticky', { id: 'note', x: -160, y: -120, w: 240, h: 200, props: { text: 'A shared idea', align: 'left', autoSize: false } });
    board.undoManager.clear();
  });
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function edit(page: Page) {
  await page.mouse.dblclick(610, 420);
  const input = page.getByRole('textbox', { name: 'Edit text' });
  await expect(input).toBeFocused(); return input;
}

test('native editing supports selection, cut/paste and one undoable blur commit', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const input = await edit(page);
  await page.keyboard.type('A fresh direction');
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+x'); await page.keyboard.press('Meta+v');
  await expect(input).toHaveText('A fresh direction');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.type('!');
  await page.mouse.click(1120, 800);
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A fresh directio!n' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await page.keyboard.press('Meta+z');
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A shared idea' });
});

test('real Japanese IME is visible after native composition and makes one commit', async ({ page }) => {
  const external: string[] = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).hostname !== '127.0.0.1') { external.push(url); return route.abort(); }
    return route.continue();
  });
  const input = await edit(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A shared idea' });
  await cdp.send('Input.insertText', { text: '日本語' });
  await expect(input).toHaveText('日本語');
  await page.mouse.click(1120, 800);
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: '日本語' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  expect(await page.evaluate(() => ({ visible: window.whiteboard.renderer.getTextObject('note')?.visible, stats: window.whiteboard.renderer.stats() }))).toMatchObject({ visible: true, stats: { pendingTexts: 0, textErrors: 0 } });
  expect(external).toEqual([]);
});

test('blur during composition waits and Escape leaves the document untouched', async ({ page }) => {
  const input = await edit(page);
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.textContent = '途中'; (element as HTMLElement).blur();
  });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '途中' })));
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: '途中' });
  await edit(page); await page.keyboard.type('Discard me'); await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: '途中' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
});

test('rotated zoomed editor follows the document and keeps an intervening style change', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.update('note', { rotation: Math.PI / 6 });
    app.session.setState({ camera: { x: -40, y: -20, zoom: 1.5 } });
    app.board.undoManager.clear();
    app.textEditor.open('note');
  });
  const input = page.getByRole('textbox', { name: 'Edit text' });
  await expect(input).toBeFocused();
  const box = (await input.boundingBox())!;
  expect(box.width).toBeGreaterThan(240); expect(box.x).toBeGreaterThan(300); expect(box.x).toBeLessThan(750);
  await page.keyboard.type('Still together');
  await page.evaluate(() => {
    // Exercise an independent update during the local DOM draft, without replacing it.
    window.whiteboard.board.updateStyle(['note'], { fill: '#dbe9ff' });
  });
  await expect(input).toHaveText('Still together');
  await page.keyboard.press('Meta+Enter');
  expect(await page.evaluate(() => window.whiteboard.board.read('note'))).toMatchObject({ rotation: Math.PI / 6, props: { text: 'Still together' }, style: { fill: '#dbe9ff' } });
  await page.screenshot({ path: 'test-results/app-text-rotated.png' });
});

test('intentional trailing lines survive commit, reopen, clipboard and undo', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const input = await edit(page);
  await page.keyboard.type('A'); await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.mouse.click(1120, 800);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A\n\n' });
  await edit(page); await page.mouse.click(1120, 800);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A\n\n' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await edit(page); await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+x'); await page.keyboard.press('Meta+v');
  await page.mouse.click(1120, 800);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A\n\n' });
  await edit(page);
  await page.evaluate(() => navigator.clipboard.writeText('Pasted\n\n'));
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+v'); await page.mouse.click(1120, 800);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'Pasted\n\n' });
  await page.keyboard.press('Meta+z');
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A\n\n' });
});

test('blurring an untouched text draft preserves a peer edit and creates no local history', async ({ page }) => {
  const id = await page.evaluate(() => {
    const element = window.whiteboard.board.create('text', { x: 0, y: 0, props: { text: 'Original', align: 'left', autoSize: true } });
    window.whiteboard.board.undoManager.clear(); window.whiteboard.textEditor.open(element.id); return element.id;
  });
  await expect(page.getByRole('textbox', { name: 'Edit text' })).toHaveText('Original');
  await page.evaluate(id => {
    const board = window.whiteboard.board, element = board.read(id)!;
    if (element.type !== 'text') throw new Error('Expected text');
    board.doc.transact(() => board.update(id, { props: { ...element.props, text: 'Peer version' } }), 'remote-test');
  }, id);
  await page.getByRole('heading', { name: 'Untitled board', exact: true }).click();
  expect(await page.evaluate(id => window.whiteboard.board.read(id)!.props, id)).toMatchObject({ text: 'Peer version' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
});
