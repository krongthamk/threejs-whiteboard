import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));
const onlyChecks = process.env.CHECKS_ONLY === '1';
await mkdir(artifacts, { recursive: true });
const spikesRoot = fileURLToPath(new URL('../', import.meta.url));
const buildDirectory = fileURLToPath(new URL('./dist/', import.meta.url));
await build({ configFile: false, root: spikesRoot,
  publicDir: fileURLToPath(new URL('../../packages/app/public', import.meta.url)),
  resolve: { alias: {
    '@whiteboard/model': fileURLToPath(new URL('../../packages/model/src/index.ts', import.meta.url)),
    '@whiteboard/renderer': fileURLToPath(new URL('../../packages/renderer/src/index.ts', import.meta.url)),
  } },
  build: { outDir: buildDirectory, emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) } },
});
let browser, server;
try {
  server = await preview({ configFile: false, root: spikesRoot, build: { outDir: buildDirectory }, preview: { host: '127.0.0.1', port: 4174, strictPort: true } });
  browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  page.on('console', message => {
    if (message.text().startsWith('S1_')) console.log(message.text());
    if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
  });
  page.on('requestfailed', request => console.error('REQUEST_FAILED', request.url(), request.failure()));
  await page.goto('http://127.0.0.1:4174/renderer/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.rendererBenchmark);
  const scenarios = await page.evaluate(() => window.rendererBenchmark.scenarios);
  const results = [];
  for (const scenario of onlyChecks ? [] : scenarios) {
    console.log('S1_START', scenario.name);
    results.push(await page.evaluate(config => window.rendererBenchmark.run(config), {
      ...scenario, sampleFrames: Number(process.env.SAMPLE_FRAMES ?? 600), warmupFrames: Number(process.env.WARMUP_FRAMES ?? 90),
    }));
    if (scenario.name === 'mixed-5000-2000-500') await page.screenshot({ path: `${artifacts}/mixed-board.png` });
  }
  const baseline = results[3], culled = results[4];
  const culling = onlyChecks ? null : { noOffscreenTextMeshes: culled.stats.textInstances === 0, noExtraDrawCalls: culled.stats.calls === baseline.stats.calls,
    noExtraTriangles: culled.stats.triangles === baseline.stats.triangles,
    medianCpuDeltaMs: culled.renderCpuMs.median - baseline.renderCpuMs.median,
    p95CpuDeltaMs: culled.renderCpuMs.p95 - baseline.renderCpuMs.p95 };
  const checks = await page.evaluate(async () => {
    const { renderer, fixture } = window.rendererBenchmark;
    const elements = fixture({ name: 'update-check', shapes: 9, strokes: 513, texts: 1 });
    renderer.setElements(elements); renderer.setCamera({ x: 900, y: 500, zoom: .75 }); await renderer.whenReady(); renderer.render();
    const shapeMeshes = renderer.layers.shapes.children.map(mesh => mesh.uuid);
    const chunks = renderer.layers.strokes.children.map(mesh => mesh.uuid);
    const stroke = elements.find(element => element.type === 'stroke');
    renderer.applyDiff([{ ...stroke, style: { ...stroke.style, stroke: '#ef4444' } }]); renderer.render();
    const nextChunks = renderer.layers.strokes.children.map(mesh => mesh.uuid);
    const oneStrokeChunkRebuilt = chunks.filter(id => !nextChunks.includes(id)).length === 1;
    const strokeEditPreservesShapes = shapeMeshes.every(id => renderer.layers.shapes.children.some(mesh => mesh.uuid === id));
    const shape = elements.find(element => element.type === 'rect');
    renderer.applyDiff([{ ...shape, x: shape.x + 12 }]); renderer.render();
    const shapeMovePreservesBatches = shapeMeshes.every(id => renderer.layers.shapes.children.some(mesh => mesh.uuid === id));
    const text = elements.find(element => element.type === 'text');
    renderer.applyDiff([{ ...text, props: { ...text.props, text: 'Changed text' } }]); renderer.render(); await renderer.whenReady();
    const textEditPreservesShapes = shapeMeshes.every(id => renderer.layers.shapes.children.some(mesh => mesh.uuid === id));
    const red = { ...shape, id: 'upper-rect', index: 'a1', x: 20, y: 20, w: 80, h: 80, rotation: 0,
      style: { ...shape.style, fill: '#ff0000', stroke: 'none', strokeWidth: 0, opacity: .5 } };
    const blue = { ...elements.find(element => element.type === 'ellipse'), id: 'lower-ellipse', index: 'a0', x: 20, y: 20, w: 80, h: 80, rotation: 0,
      style: { ...shape.style, fill: '#0000ff', stroke: 'none', strokeWidth: 0, opacity: 1 } };
    renderer.setElements([red, blue]);
    renderer.resize(120, 120); renderer.setCamera({ x: 60, y: 60, zoom: 1 }); renderer.render();
    const screenBytes = new Uint8Array(4), gl = renderer.webgl.getContext(); gl.readPixels(60, 60, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, screenBytes);
    const screenPixel = [...screenBytes];
    const png = await renderer.exportPng({ bounds: { x: 0, y: 0, w: 120, h: 120 }, scale: 2 });
    const bitmap = await createImageBitmap(png), output = document.createElement('canvas'); output.width = bitmap.width; output.height = bitmap.height;
    const ctx = output.getContext('2d'); ctx.drawImage(bitmap, 0, 0); const pixel = [...ctx.getImageData(120, 120, 1, 1).data]; bitmap.close();
    const translucentOrdering = Math.abs(pixel[0] - 128) <= 2 && pixel[1] === 0 && Math.abs(pixel[2] - 128) <= 2 && pixel[3] === 255;
    const screenMatchesPng = pixel.every((channel, i) => Math.abs(channel - screenPixel[i]) <= 2);
    const pngAt2x = output.width === 240 && output.height === 240;
    renderer.setElements([red]);
    const transparentPng = await renderer.exportPng({ bounds: { x: 0, y: 0, w: 120, h: 120 }, scale: 1, transparent: true });
    const transparentBitmap = await createImageBitmap(transparentPng); ctx.clearRect(0, 0, output.width, output.height); ctx.drawImage(transparentBitmap, 0, 0);
    const transparentPixel = [...ctx.getImageData(60, 60, 1, 1).data]; transparentBitmap.close();
    const transparentAlpha = transparentPixel[0] >= 253 && transparentPixel[1] === 0 && transparentPixel[2] === 0 && Math.abs(transparentPixel[3] - 128) <= 2;
    renderer.setElements(elements); renderer.render(); renderer.setElements([]); await renderer.whenReady(); renderer.render();
    const reloadClearsProjection = renderer.stats().elements === 0 && renderer.stats().shapeInstances === 0 && renderer.stats().textInstances === 0 && renderer.stats().strokeChunks === 0;
    return { oneStrokeChunkRebuilt, strokeEditPreservesShapes, shapeMovePreservesBatches, textEditPreservesShapes, translucentOrdering, screenMatchesPng, transparentAlpha,
      pngAt2x, reloadClearsProjection, overlapPixel: pixel, screenPixel, transparentPixel };
  });
  const report = { hardware: { model: cpus()[0]?.model, logicalCores: cpus().length, memoryGiB: totalmem() / 1024 ** 3, os: `${platform()} ${release()}` },
    browserVersion: browser.version(), headless: true, productionBuild: true, viewport: { width: 1440, height: 1000 },
    results, culling, checks, errors,
    passed: (onlyChecks || (results.every(result => result.meetsFps) && results[0].minVisibleTexts === 500 && results[2].minVisibleTexts === 500
      && culling.noOffscreenTextMeshes && culling.noExtraDrawCalls && culling.noExtraTriangles)) && errors.length === 0
      && Object.values(checks).filter(value => typeof value === 'boolean').every(value => value === true) };
  const artifact = `${artifacts}/${onlyChecks ? 's1-checks' : 's1-results'}.json`;
  await writeFile(artifact, JSON.stringify(report, null, 2) + '\n');
  console.log('S1_COMPLETE', JSON.stringify({ passed: report.passed, artifact, errors, checks }));
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
