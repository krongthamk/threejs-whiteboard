// Diagnostic-only probe. It wraps methods in the test page, never production source.
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), output = fileURLToPath(new URL('./dist/media/', import.meta.url));
let browser, server;
try {
  server = await preview({ configFile: false, root, build: { outDir: output }, preview: { host: '127.0.0.1', port: 4174, strictPort: true } });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4174/renderer/'); await page.waitForFunction(() => window.rendererBenchmark);
  const result = await page.evaluate(async () => {
    const { renderer, fixture } = window.rendererBenchmark;
    const elements = fixture({ name: 'diagnose-media', shapes: 5000, strokes: 2000, texts: 500 });
    const peers = Array.from({ length: 40 }, (_, i) => ({ clientId: i, name: `Collaborator ${i}`, color: '#2563eb', cursor: { x: 120 + i % 10 * 155, y: 160 + Math.floor(i / 10) * 185 }, selection: [`shape-${i * 100}`], editingTextId: `text-${i}` }));
    const timings = {}, methods = [[renderer.webgl, 'render', 'webglRender'], [renderer.presence, 'set', 'presenceSet'], [renderer.presence, 'setZoom', 'presenceZoom'], [renderer.images, 'updateVisible', 'imagesVisible'], [renderer, 'updateVisibleTexts', 'visibleTexts']];
    for (const [object, method, name] of methods) { const original = object[method].bind(object); object[method] = (...args) => { const start = performance.now(); const result = original(...args); (timings[name] ??= []).push(performance.now() - start); return result; }; }
    const frame = () => new Promise(requestAnimationFrame), results = [];
    const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] ?? 0;
    for (const variant of ['baseline', 'presence-fixed-zoom', 'presence-zoom', 'presence-hidden', 'baseline-again']) {
      renderer.setElements(elements);
      const hasPresence = variant.startsWith('presence');
      const camera = i => renderer.setCamera({ x: 900 + Math.sin(i / 70) * 24, y: 500 + Math.cos(i / 95) * 18, zoom: variant === 'presence-zoom' || variant === 'presence-hidden' ? .76 + Math.sin(i / 150) * .01 : .76 });
      camera(0); await renderer.whenReady();
      if (hasPresence) renderer.setPresence(peers); renderer.render();
      const start = performance.now(); while (renderer.stats().pendingPresenceLabels && performance.now() - start < 15000) { await frame(); renderer.render(); }
      renderer.layers.presence.visible = variant !== 'presence-hidden';
      for (let i = 0; i < 40; i++) { await frame(); camera(i); renderer.render(); }
      for (const key of Object.keys(timings)) timings[key] = [];
      let previous = await frame(); const intervals = [], cpu = [];
      for (let i = 0; i < 180; i++) {
        const now = await frame(); intervals.push(now - previous); previous = now;
        const start = performance.now(); camera(i);
        if (hasPresence) renderer.setPresence(peers.map(peer => ({ ...peer, cursor: { x: peer.cursor.x + Math.sin(i / 40) * 15, y: peer.cursor.y + Math.cos(i / 45) * 10 } })));
        renderer.render(); cpu.push(performance.now() - start);
      }
      results.push({ variant, fps: 1000 / (intervals.reduce((a, b) => a + b) / intervals.length), cpu: { median: quantile(cpu, .5), p95: quantile(cpu, .95) },
        methods: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, { median: quantile(values, .5), p95: quantile(values, .95) }])), stats: renderer.stats() });
    }
    renderer.dispose(); return results;
  });
  const report = { timestamp: new Date().toISOString(), browser: browser.version(), result };
  await writeFile(fileURLToPath(new URL('./artifacts/media-diagnostic.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve()); }
