import { expect, test } from '@playwright/test';

test('native editor rejects incomplete characters with a visible notice and keeps saved text', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.create('text', { id: 'validated-text', props: { text: 'Saved 😀', align: 'left', autoSize: true } });
    app.board.undoManager.clear(); app.textEditor.open('validated-text');
  });
  const input = page.getByRole('textbox', { name: 'Edit text' }); await expect(input).toBeFocused();
  await input.evaluate(element => { element.textContent = `x${String.fromCharCode(0xd83d)}y`; element.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('incomplete or invalid character');
  expect(await page.evaluate(() => ({ props: window.whiteboard.board.read('validated-text')!.props, history: window.whiteboard.board.undoManager.undoStack.length }))).toMatchObject({ props: { text: 'Saved 😀' }, history: 0 });
  expect(errors).toEqual([]);
});

test('create, select-all, fit and minimap use existing element projections', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.transact(() => { for (let i = 0; i < 100; i++) app.board.create('rect', { id: `cached-${i}`, x: (i % 10) * 50, y: Math.floor(i / 10) * 50, w: 30, h: 30 }); });
    const original = app.board.readAll.bind(app.board); Reflect.set(window, 'projectionReads', 0);
    app.board.readAll = () => { Reflect.set(window, 'projectionReads', Reflect.get(window, 'projectionReads') + 1); return original(); };
  });
  await page.locator('canvas').first().focus(); await page.keyboard.press('ControlOrMeta+a');
  expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds.length)).toBe(100);
  await page.evaluate(() => window.whiteboard.controller.zoomToFit());
  await page.getByRole('button', { name: 'Open minimap', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Minimap · drag to navigate, Enter to fit board' })).toBeVisible();
  await page.evaluate(() => window.whiteboard.session.setState({ tool: 'rect' }));
  await page.mouse.move(1050, 650); await page.mouse.down(); await page.mouse.move(1100, 700); await page.mouse.up();
  expect(await page.evaluate(() => Reflect.get(window, 'projectionReads'))).toBe(0);
  expect(await page.evaluate(() => window.whiteboard.elementCount)).toBe(101);
});
