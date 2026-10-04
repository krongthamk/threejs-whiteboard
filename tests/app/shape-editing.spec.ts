import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createElement, textLayout } from '@whiteboard/model';

const editor = (page: Page) => page.getByRole('textbox', { name: 'Edit text', exact: true });
const props = (page: Page, id = 'shape') => page.evaluate(id => window.whiteboard.board.read(id)?.props, id);
const history = (page: Page) => page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
const blur = (page: Page) => page.getByRole('heading', { name: 'Untitled board', exact: true }).click();

async function signIn(page: Page, username: string, path = '/') {
  await page.goto(path);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('browser-test-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function connected(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
}
const editingBadge = (page: Page) => page.evaluate(() => {
  const label = window.whiteboard.renderer.layers.presence.children[0]?.children[2];
  const text = label?.children[1] as { visible: boolean; text?: string } | undefined;
  return { visible: !!label?.visible && !!text?.visible, text: text?.text ?? '' };
});

test('authenticated native shape commit preserves whitespace, peer geometry/alignment and exact source after reload', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [alice, bob, fresh] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = []; for (const page of [alice!, bob!, fresh!]) page.on('pageerror', error => errors.push(error.message));
  const original = ' original \n\n', source = '  Native 日本語  \n\n final \t\n\n';
  try {
    await signIn(alice!, 'alice');
    await alice!.getByRole('button', { name: 'New board', exact: true }).click();
    await alice!.getByLabel('Board name', { exact: true }).fill('F1.4 native persistence');
    await alice!.getByRole('button', { name: 'Create board', exact: true }).click(); await connected(alice!);
    const path = new URL(alice!.url()).pathname, boardId = path.split('/').at(-1)!;
    await alice!.getByRole('button', { name: 'Share', exact: true }).click();
    await alice!.getByLabel('Username', { exact: true }).fill('bob');
    await alice!.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(alice!.getByText('Access granted to bob.', { exact: true })).toBeVisible();
    await alice!.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await signIn(bob!, 'bob', path); await connected(bob!);
    await alice!.evaluate(() => {
      const app = window.whiteboard;
      app.board.create('rect', { id: 'persisted-shape', x: -100, y: -80, w: 240, h: 180 });
      app.board.undoManager.clear();
    });
    await expect.poll(() => props(bob!, 'persisted-shape')).toEqual({});
    await alice!.mouse.dblclick(740, 510); await expect(editor(alice!)).toBeFocused();
    await expect.poll(() => editingBadge(bob!)).toEqual({ visible: true, text: 'alice · editing' });
    await alice!.keyboard.insertText('  Native 日本語  '); await alice!.keyboard.press('Enter'); await alice!.keyboard.press('Enter');
    await alice!.keyboard.insertText(' final \t'); await alice!.keyboard.press('Enter'); await alice!.keyboard.press('Enter');
    const draft = await editor(alice!).evaluate(element => (element as HTMLElement).innerText);
    expect(draft).toBe(source + '\n'); expect(await history(alice!)).toBe(0);
    await bob!.evaluate(original => {
      const board = window.whiteboard.board;
      board.transact(() => {
        board.move(['persisted-shape'], { x: 35, y: -7 });
        board.updateStyle(['persisted-shape'], { fill: '#dbe9ff' });
        board.update('persisted-shape', { props: { text: original, autoSize: false, align: 'right', verticalAlign: 'bottom' } });
      });
    }, original);
    await expect.poll(() => props(alice!, 'persisted-shape')).toMatchObject({ text: original, align: 'right', verticalAlign: 'bottom' });
    expect(await editor(alice!).evaluate(element => (element as HTMLElement).innerText)).toBe(draft);
    expect(await history(alice!)).toBe(0);
    await alice!.keyboard.press('ControlOrMeta+Enter'); await expect(editor(alice!)).toHaveCount(0);
    await expect.poll(async () => (await editingBadge(bob!)).visible).toBe(false);
    const expected = await alice!.evaluate(() => window.whiteboard.board.read('persisted-shape'));
    expect(expected).toMatchObject({ x: -65, y: -87, style: { fill: '#dbe9ff' },
      props: { text: source, align: 'right', autoSize: false, verticalAlign: 'bottom' } });
    expect(await history(alice!)).toBe(1);
    await expect.poll(() => bob!.evaluate(() => window.whiteboard.board.read('persisted-shape'))).toEqual(expected);
    await alice!.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => props(bob!, 'persisted-shape')).toMatchObject({ text: original, align: 'right', verticalAlign: 'bottom' });
    await alice!.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => bob!.evaluate(() => window.whiteboard.board.read('persisted-shape'))).toEqual(expected);
    await expect.poll(() => alice!.evaluate(async boardId => {
      const metrics = await (await fetch('/api/metrics')).json();
      return metrics.boards.find((board: { boardId: string }) => board.boardId === boardId)?.storage.updateCount ?? 0;
    }, boardId)).toBeGreaterThan(0);
    await contexts[0]!.close(); await contexts[1]!.close();
    await signIn(fresh!, 'alice', path); await connected(fresh!);
    expect(await fresh!.evaluate(() => window.whiteboard.board.read('persisted-shape'))).toEqual(expected);
    await fresh!.reload(); await connected(fresh!);
    expect(await fresh!.evaluate(() => window.whiteboard.board.read('persisted-shape'))).toEqual(expected);
    await fresh!.evaluate(() => {
      window.whiteboard.board.undoManager.clear(); window.whiteboard.session.setState({ selectedIds: ['persisted-shape'] });
      document.querySelector<HTMLCanvasElement>('.board-canvas')!.focus();
    });
    await fresh!.keyboard.press('Enter'); await expect(editor(fresh!)).toBeFocused();
    expect(await editor(fresh!).evaluate(element => (element as HTMLElement).innerText)).toBe(source + '\n');
    await fresh!.keyboard.press('ControlOrMeta+Enter');
    expect(await fresh!.evaluate(() => window.whiteboard.board.read('persisted-shape'))).toEqual(expected);
    expect(await history(fresh!)).toBe(0); expect(errors).toEqual([]);
    writeFileSync(testInfo.outputPath('editor-persistence.json'), JSON.stringify({ boardId, source, expected, errors, schemaVersion: 2 }, null, 2));
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test.beforeEach(async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const board = window.whiteboard.board;
    board.create('rect', { id: 'shape', x: -100, y: -80, w: 240, h: 180 });
    board.create('ellipse', { id: 'oval', x: 220, y: -80, w: 180, h: 180 });
    board.undoManager.clear();
  });
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
});

test('empty rectangle double-click opens an editing-only placeholder and Escape commits once', async ({ page }) => {
  await page.mouse.dblclick(740, 510);
  const input = editor(page); await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('data-placeholder', 'Type a label');
  expect(await input.evaluate(element => ({ text: (element as HTMLElement).innerText,
    placeholder: getComputedStyle(element, '::before').content }))).toEqual({ text: '', placeholder: '"Type a label"' });
  expect(await props(page)).toEqual({}); expect(await history(page)).toBe(0);
  await page.keyboard.insertText('Rectangle 日本語'); await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await props(page)).toEqual({ text: 'Rectangle 日本語', align: 'center', autoSize: false, verticalAlign: 'middle' });
  expect(await history(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z'); expect(await props(page)).toEqual({});
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.mouse.dblclick(740, 510); await expect(input).toHaveText('Rectangle 日本語');
  await blur(page); expect(await history(page)).toBe(1);
});

test('text-tool click edits an existing ellipse and unmodified Enter edits one selected shape', async ({ page }) => {
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.mouse.click(1030, 510);
  const input = editor(page); await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.whiteboard.textEditor.editingId)).toBe('oval');
  expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(2);
  await page.keyboard.insertText('Ellipse label'); await blur(page);
  expect(await props(page, 'oval')).toMatchObject({ text: 'Ellipse label' });
  await page.evaluate(() => { window.whiteboard.session.setState({ selectedIds: ['shape'], tool: 'select' }); document.querySelector<HTMLCanvasElement>('.board-canvas')!.focus(); });
  await page.keyboard.press('Enter'); await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.whiteboard.textEditor.editingId)).toBe('shape');
  await blur(page); expect(await props(page)).toEqual({});
});

test('shape Enter ignores multiple selection, modifiers and view-only access', async ({ page }) => {
  await page.evaluate(() => { window.whiteboard.session.setState({ selectedIds: ['shape', 'oval'] }); document.querySelector<HTMLCanvasElement>('.board-canvas')!.focus(); });
  await page.keyboard.press('Enter'); await expect(editor(page)).toHaveCount(0);
  await page.evaluate(() => window.whiteboard.session.setState({ selectedIds: ['shape'] }));
  await page.keyboard.press('Shift+Enter'); await expect(editor(page)).toHaveCount(0);
  await page.evaluate(() => { window.whiteboard.readOnly = true; });
  await page.keyboard.press('Enter'); await page.mouse.dblclick(740, 510); await expect(editor(page)).toHaveCount(0);
  expect(await props(page)).toEqual({}); expect(await history(page)).toBe(0);
});

test('a shape draft uses actual Japanese IME and commits exactly once on blur', async ({ page }) => {
  await page.evaluate(() => window.whiteboard.textEditor.open('oval'));
  const input = editor(page); await expect(input).toBeFocused();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
  expect(await props(page, 'oval')).toEqual({}); expect(await history(page)).toBe(0);
  await expect(input).toHaveAttribute('data-empty', 'false');
  await cdp.send('Input.insertText', { text: '日本語' }); await expect(input).toHaveText('日本語');
  await blur(page);
  expect(await props(page, 'oval')).toEqual({ text: '日本語', align: 'center', autoSize: false, verticalAlign: 'middle' });
  expect(await history(page)).toBe(1);
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
  expect(await page.evaluate(() => window.whiteboard.renderer.getTextObject('oval')?.visible)).toBe(true);
});

test('shape composition blur waits and clearing restores canonical props with one undo', async ({ page }) => {
  await page.evaluate(() => window.whiteboard.textEditor.open('shape'));
  const input = editor(page);
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.textContent = '途中'; (element as HTMLElement).blur();
  });
  await expect(input).toHaveCount(1); expect(await props(page)).toEqual({}); expect(await history(page)).toBe(0);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '途中' })));
  await expect(input).toHaveCount(0); expect(await props(page)).toMatchObject({ text: '途中' }); expect(await history(page)).toBe(1);
  await page.evaluate(() => { window.whiteboard.board.undoManager.clear(); window.whiteboard.textEditor.open('shape'); });
  await page.keyboard.press('Backspace'); await page.keyboard.press('Escape');
  expect(await props(page)).toEqual({}); expect(await history(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z'); expect(await props(page)).toMatchObject({ text: '途中' });
  await page.keyboard.press('ControlOrMeta+Shift+z'); expect(await props(page)).toEqual({});
});

test('fitting shape alignment follows rotation, zoom and current peer props while keeping a local draft', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.setShapeText('shape', 'Original'); app.board.update('shape', { rotation: Math.PI / 6 });
    app.session.setState({ camera: { x: 0, y: 0, zoom: 1.25 } }); app.board.undoManager.clear(); app.textEditor.open('shape');
  });
  const input = editor(page);
  expect(await input.evaluate(element => ({ left: (element as HTMLElement).style.left, top: (element as HTMLElement).style.top,
    padding: (element as HTMLElement).style.paddingTop, width: (element as HTMLElement).style.width,
    height: (element as HTMLElement).style.height, transform: element.parentElement!.style.transform }))).toMatchObject({ left: '12px', top: '12px', padding: '63px', width: '216px', height: '156px' });
  await page.keyboard.insertText('Local draft');
  const before = await input.boundingBox();
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.doc.transact(() => {
      app.board.move(['shape'], { x: 20, y: 15 });
      app.board.update('shape', { props: { text: 'Peer label', align: 'right', autoSize: false, verticalAlign: 'bottom' } });
      app.board.updateStyle(['shape'], { fill: '#dbe9ff' });
    }, 'peer-test');
  });
  await expect(input).toHaveText('Local draft');
  const after = (await input.boundingBox())!;
  expect(after.x).toBeCloseTo(before!.x + 25, 1); expect(after.y).toBeCloseTo(before!.y + 18.75, 1);
  expect(await input.evaluate(element => (element as HTMLElement).style.paddingTop)).toBe('126px');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.whiteboard.board.read('shape'))).toMatchObject({ x: -80, y: -65, rotation: Math.PI / 6,
    style: { fill: '#dbe9ff' }, props: { text: 'Local draft', align: 'right', verticalAlign: 'bottom' } });
  expect(await history(page)).toBe(1);
});

for (const initial of ['', 'Original label']) {
  test(`untouched shape draft preserves a peer ${initial ? 'removal' : 'addition'}`, async ({ page }) => {
    await page.evaluate(initial => {
      const app = window.whiteboard; if (initial) app.board.setShapeText('shape', initial);
      app.board.undoManager.clear(); app.textEditor.open('shape');
      app.board.doc.transact(() => app.board.setShapeText('shape', initial ? '' : 'Peer added label'), 'peer-test');
    }, initial);
    await expect(editor(page)).toHaveCount(1); expect(await history(page)).toBe(0);
    await blur(page);
    expect(await props(page)).toEqual(initial ? {} : { text: 'Peer added label', align: 'center', autoSize: false, verticalAlign: 'middle' });
    expect(await history(page)).toBe(0);
  });
}

for (const reason of ['deletion', 'view-only'] as const) {
  test(`shape ${reason} interruption reports a changed unsaved draft without writing`, async ({ page }) => {
    await page.evaluate(() => window.whiteboard.textEditor.open('shape')); await page.keyboard.insertText('Unsaved shape draft');
    await page.evaluate(reason => {
      const app = window.whiteboard;
      if (reason === 'deletion') app.board.doc.transact(() => app.board.delete('shape'), 'peer-test');
      else { app.readOnly = true; app.textEditor.cancel(); }
    }, reason);
    await expect(editor(page)).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('not saved');
    await expect(page.getByRole('alert')).toContainText(reason === 'deletion' ? 'removed' : 'view only');
    expect(await props(page)).toEqual(reason === 'deletion' ? undefined : {}); expect(await history(page)).toBe(0);
  });
}

test('shape typing, paste and composition keep the 50k limit and reject invalid UTF16 without silent writes', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => window.whiteboard.textEditor.open('shape')); const input = editor(page);
  await page.keyboard.insertText('x'.repeat(50_000)); await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('z');
  await expect(page.getByRole('alert')).toContainText('50,000');
  expect(await input.evaluate(element => (element as HTMLElement).innerText.length)).toBe(50_000);
  await page.evaluate(() => navigator.clipboard.writeText('no')); await page.keyboard.press('ControlOrMeta+v');
  expect(await input.evaluate(element => (element as HTMLElement).innerText.length)).toBe(50_000);
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('Saved replacement');
  await page.keyboard.press('Escape'); expect(await props(page)).toMatchObject({ text: 'Saved replacement' }); expect(await history(page)).toBe(1);
  await page.evaluate(() => { window.whiteboard.board.undoManager.clear(); window.whiteboard.textEditor.open('shape'); });
  await input.evaluate(element => {
    element.textContent = 'x'.repeat(49_999); element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.textContent += '日本語'; element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    (element as HTMLElement).blur();
  });
  await expect(input).toHaveCount(1); expect(await history(page)).toBe(0);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' })));
  expect(await props(page)).toMatchObject({ text: 'x'.repeat(49_999) }); expect(await history(page)).toBe(1);
  await page.evaluate(() => {
    window.whiteboard.board.undoManager.clear(); window.whiteboard.textEditor.open('shape');
    const input = document.querySelector<HTMLElement>('.native-text-editor')!;
    input.textContent = '\ud800'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.keyboard.press('Escape'); await expect(page.getByRole('alert')).toContainText('incomplete or invalid character');
  expect(await props(page)).toMatchObject({ text: 'x'.repeat(49_999) }); expect(await history(page)).toBe(0);
});

const longSource = 'A\n'.repeat(24_999) + 'AZ';
for (const verticalAlign of ['middle', 'bottom'] as const) {
  test(`tiny rotated shape ${verticalAlign} editor reaches and edits first/final 50k carets without scroll reset`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const model = createElement('rect', { w: 20, h: 20, props: { text: longSource, align: 'left', autoSize: false, verticalAlign } });
    const signedOffset = textLayout(model).verticalOffset!; expect(signedOffset).toBeLessThan(-300_000);
    await page.evaluate(({ text, verticalAlign }) => {
      const app = window.whiteboard;
      app.board.update('shape', { x: -10, y: -10, w: 20, h: 20, rotation: Math.PI / 7,
        props: { text, align: 'left', autoSize: false, verticalAlign } });
      app.session.setState({ camera: { x: 0, y: 0, zoom: 1.4 } }); app.board.undoManager.clear(); app.textEditor.open('shape');
    }, { text: longSource, verticalAlign });
    const input = editor(page); await expect(input).toBeFocused();
    const readCaret = () => input.evaluate(element => {
      const input = element as HTMLElement, selection = window.getSelection()!, range = document.createRange();
      range.selectNodeContents(input); range.setEnd(selection.focusNode!, selection.focusOffset);
      const caretRange = selection.getRangeAt(0).cloneRange(); caretRange.collapse(false);
      const caret = caretRange.getBoundingClientRect(), box = input.getBoundingClientRect();
      return { sourceOffset: range.toString().length, collapsed: selection.isCollapsed, scrollTop: input.scrollTop,
        maxScroll: input.scrollHeight - input.clientHeight, visible: caret.height > 0 && caret.bottom > box.top && caret.top < box.bottom && caret.right >= box.left && caret.left <= box.right };
    });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    const first = await readCaret(); expect(first.sourceOffset).toBe(0); expect(first.collapsed).toBe(true); expect(first.scrollTop).toBeLessThanOrEqual(1); expect(first.visible).toBe(true);
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.insertText('B');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    const final = await readCaret(); expect(final.sourceOffset).toBe(50_000); expect(final.collapsed).toBe(true);
    expect(final.maxScroll).toBeGreaterThan(100_000); expect(final.scrollTop).toBeGreaterThanOrEqual(final.maxScroll - 1); expect(final.visible).toBe(true);
    await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.insertText('Q');
    const preserved = await page.evaluate(() => {
      const app = window.whiteboard, input = document.querySelector<HTMLElement>('.native-text-editor')!;
      input.dataset.identity = 'same-input'; input.scrollTop = Math.round((input.scrollHeight - input.clientHeight) / 2); input.scrollLeft = 0;
      const before = { scrollTop: input.scrollTop, scrollLeft: input.scrollLeft, text: input.innerText };
      app.board.doc.transact(() => { app.board.move(['shape'], { x: 5, y: 7 }); app.board.updateStyle(['shape'], { fill: '#dbe9ff' }); }, 'peer-test');
      app.session.setState({ camera: { x: 3, y: 4, zoom: 1.2 } });
      return { before, after: { scrollTop: input.scrollTop, scrollLeft: input.scrollLeft, text: input.innerText }, identity: input.dataset.identity,
        same: input === document.querySelector('.native-text-editor'), transform: input.parentElement!.style.transform,
        padding: input.style.paddingTop, width: input.style.width, height: input.style.height };
    });
    expect(preserved.after).toEqual(preserved.before); expect(preserved.same).toBe(true); expect(preserved.identity).toBe('same-input');
    expect(preserved).toMatchObject({ padding: '0px', width: '60px', height: '30px' }); expect(preserved.transform).toContain('scale(1.2)');
    expect(await props(page)).toMatchObject({ text: longSource }); expect(await history(page)).toBe(0);
    await page.keyboard.press('Escape');
    const expectedText = 'B' + longSource.slice(1, -1) + 'Q';
    expect(await props(page)).toMatchObject({ text: expectedText, verticalAlign }); expect(await history(page)).toBe(1);
    await page.keyboard.press('ControlOrMeta+z'); expect(await props(page)).toMatchObject({ text: longSource });
    expect(await page.evaluate(() => window.whiteboard.board.read('shape'))).toMatchObject({ x: -5, y: -3, style: { fill: '#dbe9ff' } });
    writeFileSync(testInfo.outputPath('editor-caret.json'), JSON.stringify({ verticalAlign, signedOffset, sourceLength: longSource.length,
      originalSha256: createHash('sha256').update(longSource).digest('hex'), committedSha256: createHash('sha256').update(expectedText).digest('hex'), first, final,
      scrollPreserved: preserved.same && preserved.after.scrollTop === preserved.before.scrollTop, padding: preserved.padding, width: preserved.width, height: preserved.height }, null, 2));
  });
}
