import { test, expect, type Page } from '@playwright/test';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime } }
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const board = window.whiteboard.board;
    const shape = board.create('rect', { id: 'test-shape', x: -220, y: -200, w: 160, h: 120, style: { fill: '#dbe9ff' } });
    window.whiteboard.session.setState({ selectedIds: [shape.id] });
  });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
const read = (page: Page) => page.evaluate(() => window.whiteboard.board.read('test-shape')!);
const history = (page: Page) => page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
const picture = (page: Page) => page.evaluate(async () => Array.from(new Uint8Array(await (await window.whiteboard.renderer.exportPng({ bounds: { x: -300, y: -300, w: 700, h: 700 }, scale: 1 })).arrayBuffer())));

test('resize and rotate handles preview geometry then commit one undo step', async ({ page }) => {
  const before = await read(page), steps = await history(page);
  await page.mouse.move(660, 420); await page.mouse.down(); await page.mouse.move(720, 450, { steps: 8 });
  expect(await read(page)).toEqual(before); await page.mouse.up();
  expect(await read(page)).toMatchObject({ x: -220, y: -200, w: 220, h: 150 });
  expect(await history(page)).toBe(steps + 1);
  await page.keyboard.press('ControlOrMeta+z'); expect(await read(page)).toEqual(before);
  await page.mouse.move(580, 272); await page.mouse.down(); await page.mouse.move(668, 360, { steps: 8 }); await page.mouse.up();
  expect((await read(page)).rotation).toBeCloseTo(Math.PI / 2, 4);
  expect(await history(page)).toBe(steps + 1);
  await page.keyboard.press('ControlOrMeta+z'); expect(await read(page)).toEqual(before);
});

test('Escape and pointercancel restore both document and rendered geometry', async ({ page }) => {
  const before = await read(page), pixels = await picture(page), steps = await history(page);
  await page.mouse.move(580, 360); await page.mouse.down(); await page.mouse.move(740, 460, { steps: 5 });
  expect(await read(page)).toEqual(before); expect(await picture(page)).not.toEqual(pixels);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await read(page)).toEqual(before); expect(await picture(page)).toEqual(pixels); expect(await history(page)).toBe(steps);
  await page.mouse.move(580, 360); await page.mouse.down(); await page.mouse.move(700, 460);
  await page.locator('canvas').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }); await page.mouse.up();
  expect(await read(page)).toEqual(before); expect(await picture(page)).toEqual(pixels); expect(await history(page)).toBe(steps);
});

test('a concurrent geometry and style change survives local move commit', async ({ page }) => {
  await page.mouse.move(580, 360); await page.mouse.down(); await page.mouse.move(630, 390, { steps: 5 });
  await page.evaluate(() => {
    const board = window.whiteboard.board, element = board.read('test-shape')!;
    board.doc.transact(() => board.update(element.id, { x: element.x + 25, style: { ...element.style, fill: '#ff0000' } }), 'simulated-peer');
  });
  expect(await read(page)).toMatchObject({ x: -195, y: -200, style: { fill: '#ff0000' } });
  await page.mouse.up();
  expect(await read(page)).toMatchObject({ x: -145, y: -170, style: { fill: '#ff0000' } });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await read(page)).toMatchObject({ x: -195, y: -200, style: { fill: '#ff0000' } });
});

test('switching to readonly during a gesture cancels its draft without an undo step', async ({ page }) => {
  const before = await read(page), pixels = await picture(page), steps = await history(page);
  await page.mouse.move(580, 360); await page.mouse.down(); await page.mouse.move(700, 460, { steps: 5 });
  await page.evaluate(() => { window.whiteboard.readOnly = true; }); await page.mouse.up();
  expect(await read(page)).toEqual(before); expect(await picture(page)).toEqual(pixels); expect(await history(page)).toBe(steps);
  await page.keyboard.press('Delete'); expect(await read(page)).toEqual(before);
});

test('a peer deletion during a drag cannot be resurrected by pointerup', async ({ page }) => {
  await page.mouse.move(580, 360); await page.mouse.down(); await page.mouse.move(700, 460, { steps: 5 });
  await page.evaluate(() => { const board = window.whiteboard.board; board.doc.transact(() => board.delete('test-shape'), 'simulated-peer'); });
  await page.mouse.up();
  expect(await page.evaluate(() => window.whiteboard.board.readAll())).toEqual([]);
  await expect.poll(() => page.evaluate(() => window.whiteboard.renderer.stats().shapeInstances)).toBe(0);
});

test('pen previews are transient, retain pen pressure, and commit simplified input once', async ({ page }) => {
  const steps = await history(page);
  await page.evaluate(() => window.whiteboard.session.setState({ tool: 'draw' }));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, x: 500, y: 600, force: .1 });
  for (let i = 1; i <= 20; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', button: 'left', buttons: 1, x: 500 + i * 10, y: 600, force: i === 10 ? .9 : .1 });
  expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(1);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, x: 700, y: 600, force: 0 });
  const stroke = await page.evaluate(() => window.whiteboard.board.readAll().find(element => element.type === 'stroke'));
  expect(stroke?.type).toBe('stroke'); if (stroke?.type !== 'stroke') return;
  expect(stroke.props.simplified).toBe(true); expect(stroke.props.points.length).toBeLessThan(63);
  expect(Math.max(...stroke.props.points.filter((_, i) => i % 3 === 2))).toBeCloseTo(.9, 4);
  expect(await history(page)).toBe(steps + 1);
  await page.keyboard.press('ControlOrMeta+z'); expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(1);
});

test('fast erasing removes whole strokes as one gesture and Escape restores them', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.transact(() => {
      app.board.create('stroke', { id: 'stroke-a', props: { points: [-120, 0, .5, -120, 200, .5], simplified: true } });
      app.board.create('stroke', { id: 'stroke-b', props: { points: [80, 0, .5, 80, 200, .5], simplified: true } });
    });
    app.session.setState({ tool: 'eraser' });
  });
  const steps = await history(page);
  await page.mouse.move(550, 600); await page.mouse.down(); await page.mouse.move(900, 600);
  expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(3);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(3); expect(await history(page)).toBe(steps);
  await page.mouse.move(550, 600); await page.mouse.down(); await page.mouse.move(900, 600); await page.mouse.up();
  expect(await page.evaluate(() => window.whiteboard.board.readAll().map(element => element.id))).toEqual(['test-shape']);
  expect(await history(page)).toBe(steps + 1);
  await page.keyboard.press('ControlOrMeta+z'); expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(3);
});

test('text tool creates a native editable text and commits after blur', async ({ page }) => {
  await page.evaluate(() => window.whiteboard.session.setState({ tool: 'text' }));
  await page.mouse.click(550, 650);
  const input = page.getByRole('textbox', { name: 'Edit text' }); await expect(input).toBeFocused();
  await page.keyboard.type('A fresh thought'); await page.mouse.click(1050, 780);
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
  const text = await page.evaluate(() => window.whiteboard.board.readAll().find(element => element.type === 'text'));
  expect(text?.props).toMatchObject({ text: 'A fresh thought', autoSize: true });
});

test('elbow connectors bind to shape anchors and follow moved targets without connector writes', async ({ page }) => {
  await page.evaluate(() => {
    window.whiteboard.board.create('ellipse', { id: 'target', x: 130, y: -200, w: 160, h: 120 });
    window.whiteboard.session.setState({ tool: 'connector', connectorKind: 'elbow' });
  });
  await page.mouse.move(660, 360); await page.mouse.down(); await page.mouse.move(850, 360, { steps: 10 }); await page.mouse.up();
  const before = await page.evaluate(() => window.whiteboard.board.readAll().find(element => element.type === 'connector'));
  expect(before?.props).toMatchObject({ kind: 'elbow', start: { elementId: 'test-shape', nx: 1, ny: .5 }, end: { elementId: 'target', nx: 0, ny: .5 } });
  await page.mouse.move(580, 360); await page.mouse.down(); await page.mouse.move(580, 460, { steps: 5 }); await page.mouse.up();
  expect((await read(page)).y).toBe(-100);
  expect(await page.evaluate(() => window.whiteboard.board.readAll().find(element => element.type === 'connector'))).toEqual(before);
  await page.evaluate(() => window.whiteboard.board.delete('target'));
  expect(await page.evaluate(() => window.whiteboard.board.readAll().find(element => element.type === 'connector')?.props)).toMatchObject({ end: { x: 130, y: -140 } });
});
