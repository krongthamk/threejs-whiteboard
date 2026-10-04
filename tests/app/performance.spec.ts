import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';

test.afterEach(({}, testInfo) => recordBrowserEvidence(testInfo, 'docs/benchmarks/phase1'));
import { cpus, totalmem, release, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

function benchmarkHardware() {
  return { cpu: cpus()[0]?.model, logicalCores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(),
    powerSettings: platform() === 'darwin' ? execFileSync('pmset', ['-g'], { encoding: 'utf8' }) : undefined };
}

test('5,000 real document shapes pan and zoom at 55 fps in the application', async ({ page }, testInfo) => {
  test.skip(process.env.RUN_APP_BENCHMARK !== '1', 'Run the hardware gate explicitly on the accepted target with RUN_APP_BENCHMARK=1.');
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const runtime = window.whiteboard, started = performance.now();
    runtime.board.transact(() => {
      for (let i = 0; i < 5000; i++) runtime.board.create(i % 2 ? 'ellipse' : 'rect', {
        id: `shape-${i}`, x: i % 100 * 14 - 700, y: Math.floor(i / 100) * 14 - 350,
        w: 11, h: 11, style: { strokeWidth: 1, fill: ['#dbe9ff', '#dff3e5', '#fff0ad'][i % 3] },
      });
    });
    const preparationMs = performance.now() - started;
    await runtime.renderer.whenReady();
    const tick = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    for (let i = 0; i < 90; i++) await tick();
    const samples: number[] = []; let previous = await tick();
    for (let i = 0; i < 360; i++) {
      runtime.session.setState({ camera: { x: Math.sin(i / 60) * 100, y: Math.cos(i / 60) * 60, zoom: .8 + .2 * Math.sin(i / 90) } });
      const now = await tick(); samples.push(now - previous); previous = now;
    }
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const stats = runtime.renderer.stats();
    return {
      frames: samples.length, frameIntervalsMs: samples,
      fps: 1000 * samples.length / samples.reduce((sum, duration) => sum + duration, 0),
      preparationMs, stats,
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : gl.getParameter(gl.RENDERER) as string,
      userAgent: navigator.userAgent, schemaVersion: runtime.board.meta.get('schemaVersion'),
    };
  });
  const directory = evidenceDirectory(testInfo);
  await writeFile(`${directory}/application-performance.json`, `${JSON.stringify({ timestamp: new Date().toISOString(), viewport: page.viewportSize(), hardware: benchmarkHardware(), ...result, errors, passed: result.fps >= 55 && result.stats.shapeInstances === 5000 && errors.length === 0 }, null, 2)}\n`);
  expect(result.stats.shapeInstances).toBe(5000);
  expect(result.fps).toBeGreaterThanOrEqual(55);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `${directory}/5000-shapes.png` });
});

test('incremental 5,000-stroke native commit and eraser sweep meet main-thread budgets', async ({ page }, testInfo) => {
  test.skip(process.env.RUN_APP_BENCHMARK !== '1', 'Run the hardware gate explicitly on the accepted target with RUN_APP_BENCHMARK=1.');
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const fixture = await page.evaluate(async () => {
    const { board, renderer, session } = window.whiteboard;
    board.transact(() => {
      for (let i = 0; i < 5000; i++) {
        // The first ten known strokes occupy the early chunk and lie on one onscreen sweep.
        const x = i < 10 ? -300 + i * 60 : 10000 + i % 100 * 80;
        const y = i < 10 ? 0 : 10000 + Math.floor(i / 100) * 40;
        const points = Array.from({ length: 32 }, (_, step) => [x + step * 2, y + Math.sin(step / 4) * 5, .5]).flat();
        board.create('stroke', { id: `ink-${i}`, x, y, w: 62, h: 10, props: { points, simplified: true }, style: { strokeWidth: 2 } });
      }
      board.create('connector', { id: 'bound', props: { start: { elementId: 'ink-0', nx: 1, ny: .5, fallback: { x: 0, y: 0 } }, end: { x: 200, y: 200 }, kind: 'straight' } });
      board.create('connector', { id: 'unrelated', props: { start: { elementId: 'ink-4900', nx: 1, ny: .5, fallback: { x: 0, y: 0 } }, end: { x: 500, y: 500 }, kind: 'straight' } });
    });
    await renderer.whenReady(); renderer.render();
    const before = renderer.stats();
    const canvas = document.querySelector('canvas')!, bounds = canvas.getBoundingClientRect();
    const samples: { type: string; tool: string; durationMs: number; controllerMs: number; renderMs: number; chunks: number; connectors: number }[] = [];
    const starts = new WeakMap<Event, { time: number; chunks: number; connectors: number }>();
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      // Native Chrome mouse events go through the unchanged controller listeners.
      canvas.addEventListener(type, event => {
        const stats = renderer.stats();
        starts.set(event, { time: performance.now(), chunks: stats.strokeChunkRebuilds, connectors: stats.connectorRebuilds });
      }, { capture: true });
      canvas.addEventListener(type, event => {
        const start = starts.get(event)!;
        // Include actual geometry upload and draw calls in the main-thread interval.
        const controllerMs = performance.now() - start.time, renderStarted = performance.now();
        renderer.render(); const renderMs = performance.now() - renderStarted;
        const durationMs = performance.now() - start.time, stats = renderer.stats();
        samples.push({ type, tool: session.getState().tool, durationMs, controllerMs, renderMs,
          chunks: stats.strokeChunkRebuilds - start.chunks, connectors: stats.connectorRebuilds - start.connectors });
        canvas.dataset.strokeTimings = JSON.stringify(samples);
      });
    }
    session.setState({ tool: 'draw' });
    return { before, center: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } };
  });
  const { x, y } = fixture.center;
  // Commit one actual pen gesture while preserving the 5,000 existing strokes.
  await page.mouse.move(x - 200, y + 150); await page.mouse.down();
  await page.mouse.move(x - 170, y + 165); await page.mouse.move(x - 140, y + 150); await page.mouse.up();
  const afterCommit = await page.evaluate(() => window.whiteboard.renderer.stats());
  await page.evaluate(() => window.whiteboard.session.setState({ tool: 'eraser' }));
  await page.mouse.move(x - 330, y); await page.mouse.down();
  await page.mouse.move(x + 350, y); await page.mouse.up();
  const result = await page.evaluate(() => {
    const { board, renderer } = window.whiteboard, canvas = document.querySelector('canvas')!;
    const events = JSON.parse(canvas.dataset.strokeTimings!) as { type: string; tool: string; durationMs: number; chunks: number; connectors: number }[];
    const commit = events.find(event => event.tool === 'draw' && event.type === 'pointerup')!;
    const eraser = events.filter(event => event.tool === 'eraser');
    const gl = canvas.getContext('webgl2')!, debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { commitMs: commit.durationMs, eraseMs: eraser.reduce((total, event) => total + event.durationMs, 0), events,
      commitChunks: commit.chunks, commitConnectors: commit.connectors,
      eraseChunks: eraser.reduce((total, event) => total + event.chunks, 0), eraseConnectors: eraser.reduce((total, event) => total + event.connectors, 0),
      afterErase: renderer.stats(),
      opaqueArrowDrawMeshes: renderer.layers.connectors.children.filter(mesh => mesh.name === 'opaqueConnectorArrowheads').length,
      removedIdsAbsent: Array.from({ length: 10 }, (_, i) => board.read(`ink-${i}`) === undefined).every(Boolean),
      untouchedIdsPresent: Array.from({ length: 4990 }, (_, i) => board.read(`ink-${i + 10}`)?.type === 'stroke').every(Boolean),
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : gl.getParameter(gl.RENDERER) as string,
      userAgent: navigator.userAgent };
  });
  const directory = evidenceDirectory(testInfo);
  await writeFile(`${directory}/incremental-stroke-performance.json`, `${JSON.stringify({ timestamp: new Date().toISOString(), hardware: benchmarkHardware(), before: fixture.before, afterCommit, ...result, errors }, null, 2)}\n`);
  expect(result.opaqueArrowDrawMeshes).toBe(1);
  expect(result.commitChunks).toBe(1); expect(result.eraseChunks).toBe(1);
  expect(result.commitConnectors).toBe(0); expect(result.eraseConnectors).toBe(2);
  expect(result.removedIdsAbsent).toBe(true); expect(result.untouchedIdsPresent).toBe(true);
  expect(afterCommit.elements).toBe(5003); expect(result.afterErase.elements).toBe(4993);
  expect(result.commitMs).toBeLessThan(16); expect(result.eraseMs).toBeLessThan(50);
  expect(errors).toEqual([]);
});
