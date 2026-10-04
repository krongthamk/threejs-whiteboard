import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    window.whiteboard.board.create('rect', { id: 'before-touch', x: -350, y: -200 });
    window.whiteboard.board.undoManager.clear();
  });
});

test('a second touch cancels the creation draft and pinch zooms around the moving centroid', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  const point = (id: number, x: number, y: number) => ({ id, x, y, radiusX: 1, radiusY: 1, force: .5 });
  const first = point(1, 940, 620), second = point(2, 1140, 620);
  const bounds = (await page.locator('.board-canvas').boundingBox())!;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, 900, 600)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, 840, 620), point(2, 1240, 620)] });
    await expect.poll(() => page.evaluate(() => window.whiteboard.session.getState().camera.zoom)).toBeCloseTo(2, 3);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, 880, 680), point(2, 1280, 680)] });
    const anchor = { x: 1040 - bounds.x - bounds.width / 2, y: 620 - bounds.y - bounds.height / 2 };
    await expect.poll(() => page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual({
      x: anchor.x - (1080 - bounds.x - bounds.width / 2) / 2,
      y: anchor.y - (680 - bounds.y - bounds.height / 2) / 2, zoom: 2,
    });
    const camera = await page.evaluate(() => window.whiteboard.session.getState().camera);
    expect(camera.x + (1080 - bounds.x - bounds.width / 2) / camera.zoom).toBeCloseTo(anchor.x, 3);
    expect(camera.y + (680 - bounds.y - bounds.height / 2) / camera.zoom).toBeCloseTo(anchor.y, 3);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await page.evaluate(() => window.whiteboard.board.readAll().map(element => element.id))).toEqual(['before-touch']);
    expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.whiteboard.renderer.stats().shapeInstances)).toBe(1);
    await page.mouse.move(900, 650); await page.mouse.down(); await page.mouse.move(1020, 740); await page.mouse.up();
    expect(await page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(2);
    expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  } finally { await cdp.detach(); }
});

test('viewers can pan with two fingers and touch cancellation leaves mouse navigation usable', async ({ page }) => {
  await page.evaluate(() => { window.whiteboard.readOnly = true; });
  const cdp = await page.context().newCDPSession(page);
  const points = (dx = 0, dy = 0) => [{ id: 1, x: 850 + dx, y: 600 + dy }, { id: 2, x: 1050 + dx, y: 600 + dy }];
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points() });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(80, 60) });
    await expect.poll(() => page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual({ x: -80, y: -60, zoom: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.getByRole('button', { name: 'Pan', exact: true }).click();
    await page.mouse.move(800, 600); await page.mouse.down(); await page.mouse.move(850, 640); await page.mouse.up();
    expect(await page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual({ x: -130, y: -100, zoom: 1 });
    expect(await page.evaluate(() => window.whiteboard.board.readAll().map(element => element.id))).toEqual(['before-touch']);
    expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  } finally { await cdp.detach(); }
});
