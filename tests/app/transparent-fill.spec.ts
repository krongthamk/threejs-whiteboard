import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory } from '../evidence';

async function seed(page: Page, type: 'rect' | 'ellipse' = 'rect', labeled = false, fill = '#ffffff') {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(({ type, labeled, fill }) => {
    const { board, session } = window.whiteboard;
    board.create('rect', { id: 'lower', x: -120, y: -90, w: 240, h: 180, style: { fill: '#24a673', strokeWidth: 0 } });
    board.create(type, { id: 'upper', x: -90, y: -60, w: 180, h: 120, style: { fill, stroke: '#0033cc', strokeWidth: 8, color: '#000000', fontSize: 24 },
      props: labeled ? { text: 'HI', align: 'center', autoSize: false, verticalAlign: 'middle' } : {} });
    session.setState({ tool: 'select', selectedIds: ['upper'], camera: { x: 0, y: 0, zoom: 1 } }); board.undoManager.clear();
  }, { type, labeled, fill });
}

async function projection(page: Page, labeled: boolean) {
  return page.evaluate(async labeled => {
    const { renderer, exporter, board } = window.whiteboard;
    const raster = (source: CanvasImageSource, width: number, height: number) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const paint = canvas.getContext('2d')!; paint.drawImage(source, 0, 0, width, height); return { canvas, paint };
    };
    const sample = (paint: CanvasRenderingContext2D, x: number, y: number) => [...paint.getImageData(x, y, 1, 1).data];
    const ink = (paint: CanvasRenderingContext2D, x: number, y: number) => {
      const data = paint.getImageData(x, y, 180, 120).data; let count = 0;
      for (let at = 0; at < data.length; at += 4) if (data[at + 3]! > 240 && Math.max(data[at]!, data[at + 1]!, data[at + 2]!) < 30) count++;
      return count;
    };
    const layers = [renderer.layers.grid, renderer.layers.selectionUI, renderer.layers.presence], visible = layers.map(layer => layer.visible);
    let live;
    try {
      layers.forEach(layer => { layer.visible = false; }); await renderer.whenReady(); renderer.render();
      const width = renderer.webgl.domElement.clientWidth, height = renderer.webgl.domElement.clientHeight, image = raster(renderer.webgl.domElement, width, height);
      live = { center: sample(image.paint, width / 2, height / 2 + (labeled ? 35 : 0)), stroke: sample(image.paint, width / 2 - 90, height / 2), ink: ink(image.paint, width / 2 - 90, height / 2 - 60), data: image.canvas.toDataURL() };
    } finally { layers.forEach((layer, i) => { layer.visible = visible[i]!; }); renderer.render(); }
    const options = { padding: 0, scale: 1, transparent: false, title: 'No fill' };
    const pngBlob = await exporter.create({ ...options, format: 'png' }), bitmap = await createImageBitmap(pngBlob), png = raster(bitmap, bitmap.width, bitmap.height); bitmap.close();
    const svgBlob = await exporter.create({ ...options, format: 'svg' }), svg = await svgBlob.text(), parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    for (const [, family, data] of (parsed.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)) document.fonts.add(await new FontFace(family!, `url(${data})`).load());
    const url = URL.createObjectURL(svgBlob), image = new Image(); image.src = url; await image.decode(); const svgImage = raster(image, image.width, image.height); URL.revokeObjectURL(url);
    const inspect = (value: typeof png) => ({ center: sample(value.paint, 120, 90 + (labeled ? 35 : 0)), stroke: sample(value.paint, 30, 90), ink: ink(value.paint, 30, 30), data: value.canvas.toDataURL(), size: [value.canvas.width, value.canvas.height] });
    return { live, png: inspect(png), svg: inspect(svgImage), svgText: svg, upper: board.read('upper'), instances: renderer.stats().shapeInstances };
  }, labeled);
}
function save(directory: string, name: string, value: string) { writeFileSync(`${directory}/${name}.png`, Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')); }
function checkProjection(value: Awaited<ReturnType<typeof projection>>, labeled: boolean) {
  for (const output of [value.live, value.png, value.svg]) {
    expect(output.center).toEqual([36, 166, 115, 255]); expect(output.stroke).toEqual([0, 51, 204, 255]);
    if (labeled) expect(output.ink).toBeGreaterThan(20); else expect(output.ink).toBe(0);
  }
  expect(value.png.size).toEqual([240, 180]); expect(value.svg.size).toEqual([240, 180]); expect(value.instances).toBe(2);
}

test('existing programmatic none fill leaves lower color, stroke and empty selection alpha intact', async ({ page }, testInfo) => {
  await seed(page, 'rect', false, 'none'); const result = await projection(page, false); checkProjection(result, false);
  expect(result.svgText).toMatch(/data-element-id="upper"[^>]*><rect[^>]*fill="none"[^>]*stroke="#0033cc"/);
  const alpha = await page.evaluate(async () => {
    const blob = await window.whiteboard.exporter.create({ format: 'png', selection: ['upper'], padding: 0, scale: 1, transparent: true, title: 'Outline only' });
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const paint = canvas.getContext('2d')!; paint.drawImage(bitmap, 0, 0); bitmap.close(); return [...paint.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
  }); expect(alpha).toEqual([0, 0, 0, 0]);
  const directory = evidenceDirectory(testInfo); save(directory, 'live', result.live.data); save(directory, 'png', result.png.data); save(directory, 'svg', result.svg.data); writeFileSync(`${directory}/outline.svg`, result.svgText);
});

for (const [type, labeled] of [['rect', false], ['ellipse', true]] as const) test(`No fill UI preserves lower color, ${type} stroke and label, precise selection and undo`, async ({ page }, testInfo) => {
  await seed(page, type, labeled); const before = await page.evaluate(() => window.whiteboard.board.read('upper')!);
  await expect(page.getByRole('button', { name: 'No fill', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: 'No fill', exact: true }).click(); await expect(page.getByRole('button', { name: 'No fill', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const result = await projection(page, labeled); checkProjection(result, labeled); expect(result.upper).toEqual({ ...before, style: { ...before.style, fill: 'none' } });
  await page.evaluate(() => window.whiteboard.session.setState({ selectedIds: [] }));
  const canvas = page.getByLabel('Whiteboard canvas', { exact: true });
  const box = (await canvas.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds)).toEqual(['upper']);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await page.evaluate(() => window.whiteboard.board.read('upper'))).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await page.getByRole('button', { name: 'Fill #dbe9ff', exact: true }).click();
  expect(await page.evaluate(() => window.whiteboard.board.read('upper')!.style.fill)).toBe('#dbe9ff'); await expect(page.getByRole('button', { name: 'No fill', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await page.evaluate(() => window.whiteboard.board.read('upper')!.style.fill)).toBe('none');
  const directory = evidenceDirectory(testInfo); save(directory, 'live', result.live.data); save(directory, 'png', result.png.data); save(directory, 'svg', result.svg.data); writeFileSync(`${directory}/outline.svg`, result.svgText); writeFileSync(`${directory}/projection.json`, JSON.stringify({ ...result, live: { ...result.live, data: undefined }, png: { ...result.png, data: undefined }, svg: { ...result.svg, data: undefined }, svgText: undefined }, null, 2)); await page.screenshot({ path: `${directory}/swatch.png` });
});

test('No fill action respects immediate runtime read-only state', async ({ page }) => {
  await seed(page); const before = await page.evaluate(() => window.whiteboard.board.readAll()); await page.evaluate(() => { window.whiteboard.readOnly = true; });
  await page.getByRole('button', { name: 'No fill', exact: true }).click();
  expect(await page.evaluate(() => window.whiteboard.board.readAll())).toEqual(before); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
});

test('authenticated viewer can select an unfilled shape but has no fill controls or style writes', async ({ page, browser }) => {
  const signIn = async (target: Page, username: string, path = '/') => {
    await target.goto(path); await target.getByLabel('Username', { exact: true }).fill(username); await target.getByLabel('Password', { exact: true }).fill('browser-test-only-password'); await target.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  await signIn(page, 'alice'); await page.getByRole('button', { name: 'New board', exact: true }).click(); await page.getByLabel('Board name', { exact: true }).fill('Unfilled viewer guard'); await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
  await page.evaluate(() => window.whiteboard.board.create('rect', { id: 'viewer-outline', x: -90, y: -60, w: 180, h: 120, style: { fill: 'none' } }));
  const path = new URL(page.url()).pathname;
  await page.getByRole('button', { name: 'Share', exact: true }).click(); await page.getByLabel('Username', { exact: true }).fill('viewer'); await page.getByLabel('Permission', { exact: true }).selectOption('viewer'); await page.getByRole('button', { name: 'Grant access', exact: true }).click(); await expect(page.getByText('Access granted to viewer.', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const context = await browser.newContext(), viewer = await context.newPage();
  try {
    await signIn(viewer, 'viewer', path); await viewer.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced); await expect(viewer.getByText('View only', { exact: true })).toBeVisible();
    const before = await viewer.evaluate(() => window.whiteboard.board.readAll()); expect(before).toHaveLength(1);
    const box = (await viewer.getByLabel('Whiteboard canvas', { exact: true }).boundingBox())!; await viewer.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await viewer.evaluate(() => window.whiteboard.session.getState().selectedIds)).toEqual(['viewer-outline']); await expect(viewer.getByRole('button', { name: 'No fill', exact: true })).toHaveCount(0);
    await viewer.evaluate(() => window.whiteboard.applyStyle({ fill: '#ff0000' })); await viewer.keyboard.press('Backspace');
    expect(await viewer.evaluate(() => window.whiteboard.board.readAll())).toEqual(before); expect(await viewer.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  } finally { await context.close(); }
});
