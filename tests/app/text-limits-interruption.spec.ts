import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.create('text', { id: 'limited-text', w: 300, h: 200, props: { text: 'Saved text', align: 'left', autoSize: false } });
    app.board.undoManager.clear(); app.textEditor.open('limited-text');
  });
});

test('native typing and paste enforce 50,000 units while selected replacement and one commit work', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const input = page.getByRole('textbox', { name: 'Edit text' }); await expect(input).toBeFocused();
  await page.keyboard.insertText('x'.repeat(50_000)); await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('z');
  expect(await input.evaluate(element => (element as HTMLElement).innerText.length)).toBe(50_000);
  await expect(page.getByRole('alert')).toContainText('50,000');
  await page.evaluate(() => navigator.clipboard.writeText('no')); await page.keyboard.press('ControlOrMeta+v');
  expect(await input.evaluate(element => (element as HTMLElement).innerText.length)).toBe(50_000);
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('y'.repeat(50_000));
  expect(await input.evaluate(element => (element as HTMLElement).innerText)).toBe('y'.repeat(50_000));
  await page.keyboard.press('Escape'); await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => ({ text: window.whiteboard.board.read('limited-text')!.props, history: window.whiteboard.board.undoManager.undoStack.length })))
    .toMatchObject({ text: { text: 'y'.repeat(50_000) }, history: 1 });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => window.whiteboard.board.read('limited-text')!.props)).toMatchObject({ text: 'Saved text' });
});

test('composition beyond the limit waits for composition end, then rejects the entire insertion with a notice', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Edit text' });
  await input.evaluate(element => {
    element.textContent = 'x'.repeat(49_999); element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.textContent += '日本語'; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
    (element as HTMLElement).blur();
  });
  await expect(input).toHaveCount(1);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' })));
  await expect(input).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('50,000');
  expect(await page.evaluate(() => ({ props: window.whiteboard.board.read('limited-text')!.props, history: window.whiteboard.board.undoManager.undoStack.length })))
    .toMatchObject({ props: { text: 'x'.repeat(49_999) }, history: 1 });
});

test('bursts of long native drafts debounce positioning while camera changes stay immediate', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const editor = window.whiteboard.textEditor, input = document.querySelector<HTMLElement>('.native-text-editor')!;
    let positions = 0;
    const original = Reflect.get(editor, 'position').bind(editor);
    Reflect.set(editor, 'position', () => { positions++; original(); });
    for (let i = 0; i < 5; i++) { input.textContent = 'x'.repeat(5_001 + i); input.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    const immediate = positions; await new Promise(resolve => setTimeout(resolve, 180)); const settled = positions;
    input.textContent += 'x'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const beforeCamera = positions; window.whiteboard.session.setState({ camera: { x: 50, y: 80, zoom: 1.5 } });
    const afterCamera = positions; window.whiteboard.textEditor.commit();
    await new Promise(resolve => setTimeout(resolve, 180));
    return { immediate, settled, camera: afterCamera - beforeCamera, afterFinish: positions - afterCamera,
      history: window.whiteboard.board.undoManager.undoStack.length };
  });
  expect(result).toEqual({ immediate: 0, settled: 1, camera: 1, afterFinish: 0, history: 1 });
});

test('peer deletion reports an unsaved draft without resurrecting the element', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Edit text' }); await page.keyboard.insertText('Unsaved peer draft');
  await page.evaluate(() => window.whiteboard.board.doc.transact(() => window.whiteboard.board.delete('limited-text'), 'peer-test'));
  await expect(input).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('not saved');
  await expect(page.getByRole('alert')).toContainText('removed');
  expect(await page.evaluate(() => ({ exists: !!window.whiteboard.board.read('limited-text'), history: window.whiteboard.board.undoManager.undoStack.length })))
    .toEqual({ exists: false, history: 0 });
});

test('read-only interruption reports changed local text without writing to the board', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Edit text' }); await page.keyboard.insertText('Unsaved viewer draft');
  await page.evaluate(() => { window.whiteboard.readOnly = true; window.whiteboard.textEditor.cancel(); });
  await expect(input).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('not saved');
  await expect(page.getByRole('alert')).toContainText('view only');
  expect(await page.evaluate(() => ({ props: window.whiteboard.board.read('limited-text')!.props, history: window.whiteboard.board.undoManager.undoStack.length })))
    .toMatchObject({ props: { text: 'Saved text' }, history: 0 });
});
