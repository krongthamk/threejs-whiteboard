import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';

test.afterEach(({}, testInfo) => recordBrowserEvidence(testInfo, 'docs/benchmarks/phase4'));
import type { ThreeRenderer } from '@whiteboard/renderer';
import type { BoardExporter } from '../../packages/app/src/export';

for (const simulateCanvasLimitedGpu of [false, true]) test(`PNG crosses its bounded GPU tile boundary without seams (${simulateCanvasLimitedGpu ? '32768px canvas-limited control' : 'native GPU'})`, async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async simulateCanvasLimitedGpu => {
    const { board, renderer: display } = window.whiteboard;
    const Renderer = display.constructor as typeof ThreeRenderer;
    const Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const nativeLimit = display.webgl.capabilities.maxTextureSize;
    const reportedLimit = simulateCanvasLimitedGpu ? 32768 : nativeLimit;
    const nativeSkipReason = reportedLimit + 40 > 32767 ? `GPU boundary ${reportedLimit + 40}px exceeds the application's 32767px canvas limit; using the bounded tile boundary.`
      : reportedLimit > 4096 ? 'The native GPU boundary exceeds the4096px tile policy; testing the bounded boundary.' : null;
    const limit = Math.min(reportedLimit, nativeLimit, 4096), width = limit + 40, height = 48;
    board.create('rect', { x: 0, y: 0, w: width, h: height, style: { fill: '#ff0000', strokeWidth: 0 } });
    board.create('rect', { x: limit - 6, y: 8, w: 12, h: 32, style: { fill: '#0000ff', strokeWidth: 0 } });
    board.create('rect', { x: 2, y: 2, w: 12, h: 12, style: { fill: '#00ff00', strokeWidth: 0 } });
    let renderedTiles = 0, targetDisposals = 0;
    const targets = new Set<NonNullable<ReturnType<ThreeRenderer['webgl']['getRenderTarget']>>>(), allocations: number[][] = [];
    const exporter = new Exporter(board, undefined, options => {
      const projection = new Renderer(options), render = projection.webgl.render.bind(projection.webgl);
      projection.webgl.capabilities.maxTextureSize = reportedLimit;
      projection.webgl.render = (scene, camera) => {
        const target = projection.webgl.getRenderTarget();
        if (target) {
          renderedTiles++; allocations.push([target.width, target.height]);
          if (!targets.has(target)) { targets.add(target); target.addEventListener('dispose', () => targetDisposals++); }
        }
        render(scene, camera);
      };
      return projection;
    });
    let blob: Blob;
    try { blob = await exporter.create({ format: 'png', scale: 1, transparent: false, title: 'Bounded tile boundary', padding: 0 }); }
    finally { exporter.destroy(); }
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
    return { nativeLimit, reportedLimit, limit, nativeSkipReason, renderedTiles, targetCount: targets.size, targetDisposals, allocations, width: canvas.width, height: canvas.height, expectedWidth: width,
      seam: [limit - 2, limit - 1, limit, limit + 1].map(x => pixel(x, 24)),
      red: [pixel(limit - 10, 24), pixel(limit + 10, 24), pixel(width - 1, 24), pixel(6, 40)], top: pixel(6, 6) };
  }, simulateCanvasLimitedGpu);
  const directory = evidenceDirectory(testInfo);
  writeFileSync(`${directory}/${simulateCanvasLimitedGpu ? 'canvas-limited-tiles' : 'native-tiles'}.json`, JSON.stringify(result, null, 2));
  expect(result.renderedTiles).toBe(2); expect(result.targetCount).toBe(1); expect(result.targetDisposals).toBe(1);
  expect(result.allocations).toEqual([[result.limit, 48], [result.limit, 48]]);
  if (simulateCanvasLimitedGpu) expect(result.nativeSkipReason).toContain('32767px canvas limit');
  expect(result.width).toBe(result.expectedWidth); expect(result.height).toBe(48);
  for (const pixel of result.seam) expect(pixel).toEqual([0, 0, 255, 255]);
  for (const pixel of result.red) expect(pixel).toEqual([255, 0, 0, 255]);
  expect(result.top).toEqual([0, 255, 0, 255]);
});

test('controlled two-axis PNG tiles equal the untiled pixels, including translucent seam crossings', async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, renderer: display } = window.whiteboard;
    board.create('rect', { x: 0, y: 0, w: 130, h: 134, style: { fill: '#ff0000', strokeWidth: 0, opacity: .4 } });
    board.create('rect', { x: 56, y: 56, w: 20, h: 20, style: { fill: '#0000ff', strokeWidth: 0, opacity: .5 } });
    const Renderer = display.constructor as typeof ThreeRenderer, Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const nativeLimit = display.webgl.capabilities.maxTextureSize;
    let controlled = false, renderedTiles = 0, targetDisposals = 0;
    const targets = new Set<NonNullable<ReturnType<ThreeRenderer['webgl']['getRenderTarget']>>>(), allocations: number[][] = [];
    const exporter = new Exporter(board, undefined, options => {
      const projection = new Renderer(options), render = projection.webgl.render.bind(projection.webgl);
      // Read the current test policy per render too, for cached and disposable projections alike.
      const exportPng = projection.exportPng.bind(projection);
      projection.exportPng = options => { projection.webgl.capabilities.maxTextureSize = controlled ? 64 : nativeLimit; return exportPng(options); };
      projection.webgl.render = (scene, camera) => {
        const target = projection.webgl.getRenderTarget();
        if (controlled && target) {
          renderedTiles++; allocations.push([target.width, target.height]);
          if (!targets.has(target)) { targets.add(target); target.addEventListener('dispose', () => targetDisposals++); }
        }
        render(scene, camera);
      };
      return projection;
    });
    const pixels = async () => {
      const bitmap = await createImageBitmap(await exporter.create({ format: 'png', scale: 1, transparent: true, title: 'Two-axis tiles', padding: 0 }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    let baseline: ImageData, tiled: ImageData;
    try { baseline = await pixels(); controlled = true; tiled = await pixels(); }
    finally { exporter.destroy(); }
    let differingChannels = 0;
    for (let index = 0; index < baseline.data.length; index++) if (baseline.data[index] !== tiled.data[index]) differingChannels++;
    return { width: tiled.width, height: tiled.height, nativeLimit, controlledLimit: 64, renderedTiles, targetCount: targets.size, targetDisposals, allocations, differingChannels,
      overlap: [...tiled.data.slice((64 * tiled.width + 64) * 4, (64 * tiled.width + 64) * 4 + 4)] };
  });
  expect(result.renderedTiles).toBe(9); expect(result.targetCount).toBe(1); expect(result.targetDisposals).toBe(1);
  expect(result.allocations).toEqual(Array.from({ length: 9 }, () => [64, 64]));
  expect(result.width).toBe(130); expect(result.height).toBe(134); expect(result.differingChannels).toBe(0);
  expect(result.overlap[3]).toBeGreaterThan(170); expect(result.overlap[3]).toBeLessThan(190);
  const directory = evidenceDirectory(testInfo);
  writeFileSync(`${directory}/controlled-tiles.json`, JSON.stringify(result, null, 2));
});

test('a real lost export context rejects the PNG and a fresh projection retries successfully', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, renderer: display } = window.whiteboard;
    board.create('rect', { x: 0, y: 0, w: 80, h: 60, style: { fill: '#00ff00', strokeWidth: 0 } });
    const Renderer = display.constructor as typeof ThreeRenderer, Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    let projections = 0, projectionDisposals = 0, loseNextTile = true;
    const exporter = new Exporter(board, undefined, options => {
      const projection = new Renderer(options); projections++;
      const render = projection.webgl.render.bind(projection.webgl), dispose = projection.dispose.bind(projection);
      const extension = projection.webgl.getContext().getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('The native context-loss regression requires WEBGL_lose_context');
      projection.dispose = () => { projectionDisposals++; dispose(); };
      projection.webgl.render = (scene, camera) => {
        render(scene, camera);
        if (projection.webgl.getRenderTarget() && loseNextTile) { loseNextTile = false; extension.loseContext(); }
      };
      return projection;
    });
    const options = { format: 'png' as const, scale: 1, transparent: false, title: 'Retry context loss', padding: 0 };
    let failure = '', green: number[] = [];
    try {
      try { await exporter.create(options); } catch (error) { failure = String(error); }
      const blob = await exporter.create(options), bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      green = [...context.getImageData(40, 30, 1, 1).data];
    } finally { exporter.destroy(); }
    return { failure, projections, projectionDisposals, green };
  });
  expect(result.failure).toContain('graphics context'); expect(result.projections).toBe(2); expect(result.projectionDisposals).toBe(2);
  expect(result.green).toEqual([0, 255, 0, 255]); expect(errors).toEqual([]);
});
