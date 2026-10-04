import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';

test.afterEach(({}, testInfo) => recordBrowserEvidence(testInfo, 'docs/benchmarks/phase4'));
import type { ThreeRenderer } from '@whiteboard/renderer';

for (const simulateCanvasLimitedGpu of [false, true]) test(`PNG crosses a GPU tile boundary without seams (${simulateCanvasLimitedGpu ? '32768px canvas-limited control' : 'native GPU'})`, async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async simulateCanvasLimitedGpu => {
    const { board, exporter } = window.whiteboard;
    const background = board.create('rect', { x: 0, y: 0, w: 1, h: 1, style: { fill: '#ff0000', strokeWidth: 0 } });
    // Initialize the actual export projection before overriding its tile limit.
    await exporter.create({ format: 'png', scale: 1, transparent: false, title: 'Initialize tile projection', padding: 0 });
    const renderer = (exporter as unknown as { renderer: ThreeRenderer }).renderer;
    const nativeLimit = renderer.webgl.capabilities.maxTextureSize;
    const reportedLimit = simulateCanvasLimitedGpu ? 32768 : nativeLimit;
    const nativeSkipReason = reportedLimit + 40 > 32767 ? `GPU boundary ${reportedLimit + 40}px exceeds the application's 32767px canvas limit; using a controlled GPU tile boundary.` : null;
    const limit = nativeSkipReason ? Math.min(nativeLimit, 2048) : nativeLimit;
    const width = limit + 40, height = 48;
    board.update(background.id, { w: width, h: height });
    board.create('rect', { x: limit - 6, y: 8, w: 12, h: 32, style: { fill: '#0000ff', strokeWidth: 0 } });
    board.create('rect', { x: 2, y: 2, w: 12, h: 12, style: { fill: '#00ff00', strokeWidth: 0 } });
    let renderedTiles = 0;
    const render = renderer.webgl.render;
    let blob: Blob;
    try {
      renderer.webgl.capabilities.maxTextureSize = limit;
      renderer.webgl.render = (scene, camera) => { if (renderer.webgl.getRenderTarget()) renderedTiles++; render.call(renderer.webgl, scene, camera); };
      blob = await exporter.create({ format: 'png', scale: 1, transparent: false, title: 'GPU tile boundary', padding: 0 });
    } finally { renderer.webgl.capabilities.maxTextureSize = nativeLimit; renderer.webgl.render = render; }
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
    return { nativeLimit, reportedLimit, limit, nativeSkipReason, renderedTiles, width: canvas.width, height: canvas.height, expectedWidth: width,
      seam: [limit - 2, limit - 1, limit, limit + 1].map(x => pixel(x, 24)),
      red: [pixel(limit - 10, 24), pixel(limit + 10, 24), pixel(width - 1, 24), pixel(6, 40)], top: pixel(6, 6) };
  }, simulateCanvasLimitedGpu);
  const directory = evidenceDirectory(testInfo);
  writeFileSync(`${directory}/${simulateCanvasLimitedGpu ? 'canvas-limited-tiles' : 'native-tiles'}.json`, JSON.stringify(result, null, 2));
  expect(result.renderedTiles).toBe(2);
  if (simulateCanvasLimitedGpu) expect(result.nativeSkipReason).toContain('32767px canvas limit');
  expect(result.width).toBe(result.expectedWidth); expect(result.height).toBe(48);
  for (const pixel of result.seam) expect(pixel).toEqual([0, 0, 255, 255]);
  for (const pixel of result.red) expect(pixel).toEqual([255, 0, 0, 255]);
  expect(result.top).toEqual([0, 255, 0, 255]);
});

test('controlled two-axis PNG tiles equal the untiled pixels, including translucent seam crossings', async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, exporter } = window.whiteboard;
    board.create('rect', { x: 0, y: 0, w: 130, h: 134, style: { fill: '#ff0000', strokeWidth: 0, opacity: .4 } });
    board.create('rect', { x: 56, y: 56, w: 20, h: 20, style: { fill: '#0000ff', strokeWidth: 0, opacity: .5 } });
    const pixels = async () => {
      const bitmap = await createImageBitmap(await exporter.create({ format: 'png', scale: 1, transparent: true, title: 'Two-axis tiles', padding: 0 }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const baseline = await pixels();
    const renderer = (exporter as unknown as { renderer: ThreeRenderer }).renderer;
    const nativeLimit = renderer.webgl.capabilities.maxTextureSize;
    let tiled: ImageData;
    try { renderer.webgl.capabilities.maxTextureSize = 64; tiled = await pixels(); }
    finally { renderer.webgl.capabilities.maxTextureSize = nativeLimit; }
    let differingChannels = 0;
    for (let index = 0; index < baseline.data.length; index++) if (baseline.data[index] !== tiled.data[index]) differingChannels++;
    return { width: tiled.width, height: tiled.height, nativeLimit, controlledLimit: 64, expectedTiles: 9, differingChannels,
      overlap: [...tiled.data.slice((64 * tiled.width + 64) * 4, (64 * tiled.width + 64) * 4 + 4)] };
  });
  expect(result.width).toBe(130); expect(result.height).toBe(134); expect(result.differingChannels).toBe(0);
  expect(result.overlap[3]).toBeGreaterThan(170); expect(result.overlap[3]).toBeLessThan(190);
  const directory = evidenceDirectory(testInfo);
  writeFileSync(`${directory}/controlled-tiles.json`, JSON.stringify(result, null, 2));
});
