import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, release, platform } from 'node:os';

test('5,000 real document shapes pan and zoom at 55 fps in the application', async ({ page }) => {
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
  await mkdir('docs/benchmarks/phase1', { recursive: true });
  await writeFile('docs/benchmarks/phase1/application-performance.json', `${JSON.stringify({ timestamp: new Date().toISOString(), viewport: page.viewportSize(), hardware: { cpu: cpus()[0]?.model, logicalCores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release() }, ...result, errors, passed: result.fps >= 55 && result.stats.shapeInstances === 5000 && errors.length === 0 }, null, 2)}\n`);
  expect(result.stats.shapeInstances).toBe(5000);
  expect(result.fps).toBeGreaterThanOrEqual(55);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'docs/benchmarks/phase1/5000-shapes.png' });
});
