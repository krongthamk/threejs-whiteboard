import { test, expect, type Page } from '@playwright/test';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime } }

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page)!.push(error.message));
  await page.goto('/?local=1');
  await page.waitForFunction(() => !!window.whiteboard);
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function draw(page: Page, tool: string, x = 500, y = 300, w = 160, h = 120) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + w, y + h, { steps: 8 }); await page.mouse.up();
}
async function elements(page: Page) { return page.evaluate(() => window.whiteboard.board.readAll()); }

test('shape preview commits once, undo/redo and cancellation preserve the document', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(660, 420, { steps: 8 });
  expect(await elements(page)).toHaveLength(0);
  await page.mouse.up();
  const created = (await elements(page))[0]!;
  expect(created).toMatchObject({ type: 'rect', x: -220, y: -200, w: 160, h: 120 });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await elements(page)).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect(await elements(page)).toEqual([created]);
  await page.getByRole('button', { name: 'Ellipse', exact: true }).click();
  await page.mouse.move(800, 300); await page.mouse.down(); await page.mouse.move(950, 440);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await elements(page)).toEqual([created]);
});

test('rectangle, ellipse and sticky tools create real projected elements', async ({ page }) => {
  await draw(page, 'Rectangle'); await draw(page, 'Ellipse', 760, 280, 150, 100); await draw(page, 'Sticky note', 970, 500, 180, 160);
  expect((await elements(page)).map(element => element.type).sort()).toEqual(['ellipse', 'rect', 'sticky']);
  await expect.poll(() => page.evaluate(() => window.whiteboard.renderer.stats().shapeInstances)).toBe(3);
  await page.screenshot({ path: 'test-results/app-core-shapes.png' });
});

test('shift selection moves both shapes as one gesture and local history restores them', async ({ page }) => {
  await draw(page, 'Rectangle'); await draw(page, 'Ellipse', 850, 300);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.mouse.click(550, 350); await page.keyboard.down('Shift'); await page.mouse.click(920, 350); await page.keyboard.up('Shift');
  expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds.length)).toBe(2);
  const before = await elements(page);
  const history = await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
  await page.mouse.move(550, 350); await page.mouse.down(); await page.mouse.move(630, 400, { steps: 10 }); await page.mouse.up();
  const after = await elements(page);
  for (const old of before) expect(after.find(element => element.id === old.id)).toMatchObject({ x: old.x + 80, y: old.y + 50 });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(history + 1);
  await page.keyboard.press('Meta+z'); expect(await elements(page)).toEqual(before);
});

test('marquee, duplicate, nudge, style and delete are undoable', async ({ page }) => {
  await draw(page, 'Rectangle'); await draw(page, 'Ellipse', 850, 300);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.mouse.move(440, 240); await page.mouse.down(); await page.mouse.move(1060, 470, { steps: 10 }); await page.mouse.up();
  expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds.length)).toBe(2);
  await page.keyboard.press('Meta+d'); expect(await elements(page)).toHaveLength(4);
  const before = await elements(page);
  await page.keyboard.press('Shift+ArrowRight');
  expect(await elements(page)).not.toEqual(before);
  await page.keyboard.press('Meta+z'); expect(await elements(page)).toEqual(before);
  await page.getByRole('button', { name: 'Fill #dbe9ff', exact: true }).click();
  const selected = await page.evaluate(() => window.whiteboard.session.getState().selectedIds.map(id => window.whiteboard.board.read(id)!.style.fill));
  expect(selected).toEqual(['#dbe9ff', '#dbe9ff']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await elements(page)).toEqual(before);
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click(); expect(await elements(page)).toHaveLength(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await elements(page)).toEqual(before);
});

test('camera zoom anchors at the cursor and persists independently of a hard document reload', async ({ page }) => {
  await draw(page, 'Rectangle');
  const point = { x: 1000, y: 650 };
  const old = await page.evaluate(() => window.whiteboard.session.getState().camera);
  await page.mouse.move(point.x, point.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -180); await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => window.whiteboard.session.getState().camera.zoom)).toBeGreaterThan(old.zoom);
  const camera = await page.evaluate(() => window.whiteboard.session.getState().camera);
  expect(camera.x + (point.x - 720) / camera.zoom).toBeCloseTo(old.x + (point.x - 720) / old.zoom, 3);
  expect(camera.y + (point.y - 500) / camera.zoom).toBeCloseTo(old.y + (point.y - 500) / old.zoom, 3);
  await page.keyboard.down('Space'); await page.mouse.move(950, 650); await page.mouse.down(); await page.mouse.move(1030, 720, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Space');
  const persisted = await page.evaluate(() => window.whiteboard.session.getState().camera);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('whiteboard:view:local') ?? 'null'))).toEqual(persisted);
  await page.reload(); await page.waitForFunction(() => !!window.whiteboard);
  expect(await page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual(persisted);
  expect(await elements(page)).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => window.whiteboard.renderer.stats().shapeInstances)).toBe(0);
});

test('typing a style value commits one undo step and Escape cancels a draft', async ({ page }) => {
  await draw(page, 'Rectangle');
  const before = await elements(page);
  const steps = await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
  const width = page.getByLabel('Width', { exact: true });
  await width.fill('12'); expect(await elements(page)).toEqual(before);
  await width.press('Enter');
  expect((await elements(page))[0]!.style.strokeWidth).toBe(12);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(steps + 1);
  await width.fill('25'); await width.press('Escape');
  expect((await elements(page))[0]!.style.strokeWidth).toBe(12);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await elements(page)).toEqual(before);
});

test('narrow viewport keeps tools, selection controls and zoom reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await draw(page, 'Rectangle', 115, 340, 145, 110);
  await expect(page.getByRole('button', { name: 'Delete selection', exact: true })).toBeVisible();
  for (const name of ['Select', 'Undo', 'Zoom in', 'Zoom to fit']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: 'test-results/app-core-narrow.png' });
});
