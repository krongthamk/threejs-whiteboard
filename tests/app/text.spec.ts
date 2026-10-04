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
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+x'); await page.keyboard.press('ControlOrMeta+v');
  await expect(input).toHaveText('A fresh direction');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.type('!');
  await page.mouse.click(1120, 800);
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A fresh directio!n' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
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

test('blur during composition waits and Escape commits one undoable edit', async ({ page }) => {
  const input = await edit(page);
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.textContent = '途中'; (element as HTMLElement).blur();
  });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '途中' })));
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: '途中' });
  await edit(page); await page.keyboard.type('Keep this draft'); await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'Keep this draft' });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(2);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: '途中' });
});

test('rotated zoomed editor follows the document and keeps an intervening style change', async ({ page }, testInfo) => {
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
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(await page.evaluate(() => window.whiteboard.board.read('note'))).toMatchObject({ rotation: Math.PI / 6, props: { text: 'Still together' }, style: { fill: '#dbe9ff' } });
  await page.screenshot({ path: testInfo.outputPath('app-text-rotated.png') });
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
  await edit(page); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+x'); await page.keyboard.press('ControlOrMeta+v');
  await page.mouse.click(1120, 800);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'A\n\n' });
  await edit(page);
  await page.evaluate(() => navigator.clipboard.writeText('Pasted\n\n'));
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+v'); await page.mouse.click(1120, 800);
  expect(await page.evaluate(() => window.whiteboard.board.read('note')?.props)).toMatchObject({ text: 'Pasted\n\n' });
  await page.keyboard.press('ControlOrMeta+z');
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

test('native sticky drag retains its ready text mesh with zero disposals and no placeholders', async ({ page }, testInfo) => {
  const before = await page.evaluate(() => ({ uuid: window.whiteboard.renderer.getTextObject('note')!.uuid,
    disposals: window.whiteboard.renderer.stats().textDisposals, x: window.whiteboard.board.read('note')!.x }));
  await page.mouse.move(610, 420); await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(610 + step * 6, 420 + step * 3);
    const state = await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const renderer = window.whiteboard.renderer, mesh = renderer.getTextObject('note')!;
      return { uuid: mesh.uuid, visible: mesh.visible, disposals: renderer.stats().textDisposals,
        otherVisible: renderer.layers.text.children.filter(child => child !== mesh && child.visible).length };
    });
    expect(state).toEqual({ uuid: before.uuid, visible: true, disposals: before.disposals, otherVisible: 0 });
  }
  await page.mouse.up();
  const after = await page.evaluate(() => ({ uuid: window.whiteboard.renderer.getTextObject('note')!.uuid,
    disposals: window.whiteboard.renderer.stats().textDisposals, x: window.whiteboard.board.read('note')!.x }));
  expect(after.uuid).toBe(before.uuid); expect(after.disposals).toBe(before.disposals);
  expect(after.x).toBeGreaterThan(before.x + 50);
  await page.screenshot({ path: testInfo.outputPath('native-drag-text.png') });
});
