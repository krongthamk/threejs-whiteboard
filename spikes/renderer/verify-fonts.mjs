import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const externalRequests = [], errors = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http') && !url.startsWith('http://127.0.0.1:4173')) { externalRequests.push(url); return route.abort('internetdisconnected'); }
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173/text/'); await page.evaluate(() => window.textSpike.ready);
  await page.evaluate(() => window.textSpike.beginEdit('editable'));
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await session.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
  await session.send('Input.insertText', { text: '日本語' });
  await page.getByRole('heading').click();
  const japanese = await page.evaluate(async () => {
    await window.textSpike.renderer.whenReady(); window.textSpike.renderer.render();
    const mesh = window.textSpike.renderer.getTextObject('editable');
    const png = await window.textSpike.png(2);
    return { document: window.textSpike.board.read('editable').props.text, stats: window.textSpike.renderer.stats(),
      visible: mesh.visible, glyphs: mesh.textRenderInfo.glyphAtlasIndices.length, text: mesh.text, png };
  });
  assert.equal(japanese.document, '日本語'); assert.equal(japanese.text, '日本語'); assert.equal(japanese.visible, true);
  assert.equal(japanese.glyphs, 3); assert.equal(japanese.stats.pendingTexts, 0); assert.equal(japanese.stats.textErrors, 0);
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/japanese-offline@2x.png`, Buffer.from(japanese.png.split(',')[1], 'base64'));
  await page.screenshot({ path: `${artifacts}/japanese-offline-prototype.png` });
  await session.detach();

  await page.goto('http://127.0.0.1:4173/renderer/');
  await page.waitForFunction(() => window.rendererBenchmark);
  const missingFont = await page.evaluate(async () => {
    const { createRenderer, fixture } = window.rendererBenchmark;
    const canvas = document.createElement('canvas');
    const renderer = createRenderer({ canvas, fontUrl: '/fonts/intentional-missing-font.woff', fontLoadTimeoutMs: 250 });
    renderer.setElements(fixture({ name: 'missing-font', shapes: 0, strokes: 0, texts: 1 }));
    const start = performance.now(); let error = null;
    try { await renderer.whenReady(); } catch (failure) { error = failure.message; }
    const result = { error, elapsedMs: performance.now() - start, stats: renderer.stats(), exposedError: renderer.getTextError('text-0')?.message };
    renderer.dispose(); return result;
  });
  assert.match(missingFont.error, /failed to load its font\/layout/); assert.equal(missingFont.exposedError, missingFont.error);
  assert.equal(missingFont.stats.pendingTexts, 0); assert.equal(missingFont.stats.textErrors, 1); assert(missingFont.elapsedMs < 2000);
  const { png, ...japaneseResult } = japanese;
  const report = { passed: true, japanese: japaneseResult, externalRequests, errors, missingFont, timestamp: new Date().toISOString() };
  await writeFile(`${artifacts}/font-checks.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
