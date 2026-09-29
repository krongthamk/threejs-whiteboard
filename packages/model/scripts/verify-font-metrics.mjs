/** Requires pnpm dev:spikes. Independent browser measurement of the checked-in deterministic metrics. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = process.env.SPIKE_ORIGIN ?? 'http://127.0.0.1:4173';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${origin}/text/`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ origin, modelPath }) => {
    const model = await import(`${origin}/@fs${modelPath}`);
    for (const [family, file] of [['Inter', 'inter-latin-400-normal.woff'], ['IBM Plex Mono', 'ibm-plex-mono-latin-400-normal.woff']]) {
      const face = new FontFace(family, `url(${origin}/fonts/${file})`);
      await face.load(); document.fonts.add(face);
    }
    const context = document.createElement('canvas').getContext('2d');
    context.fontKerning = 'normal';
    const strings = ['Hello', 'AVATAR', 'To WAVE or not?', 'A shared place to think', 'Ideas take shape', 'Wi iii WWW — 0123456789', 'café déjà vu', 'cafe\u0301 de\u0301ja\u0300 vu', 'office affinity ffi fl fi', 'ÁVÀTÄR'];
    const results = [];
    for (const family of ['Inter', 'IBM Plex Mono']) for (const size of [12, 24, 48]) for (const text of strings) {
      context.font = `${size}px "${family}"`;
      const browser = context.measureText(text).width;
      const modelWidth = model.measureTextWidth(text, size, family);
      results.push({ family, size, text, browser, model: modelWidth, error: Math.abs(browser - modelWidth) });
    }
    const wraps = [];
    for (const family of ['Inter', 'IBM Plex Mono']) for (const text of ['one two three four', 'A shared place to think', 'abcdefghijk WWW iii']) {
      const element = model.createElement('text', { w: 96, style: { fontFamily: family }, props: { text, align: 'left', autoSize: false } });
      const layout = model.textLayout(element);
      const container = document.createElement('div');
      container.style.cssText = `position:fixed;left:0;top:0;width:96px;font:24px "${family}";line-height:1.25;white-space:pre-wrap;overflow-wrap:anywhere;`;
      const node = document.createTextNode(text); container.append(node); document.body.append(container);
      const byTop = new Map();
      for (let index = 0; index < text.length; index++) {
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
        const top = range.getBoundingClientRect().top;
        byTop.set(top, (byTop.get(top) ?? '') + text[index]);
      }
      container.remove();
      const browserLines = [...byTop.values()].map(line => line.trimEnd());
      const modelLines = layout.lines.map(line => line.text.trimEnd());
      wraps.push({ family, text, width: 96, browserLines, modelLines, matches: JSON.stringify(browserLines) === JSON.stringify(modelLines) });
    }
    return { samples: results.length, maxError: Math.max(...results.map(result => result.error)), wrapSamples: wraps.length, wrapMismatches: wraps.filter(wrap => !wrap.matches).length, results, wraps };
  }, { origin, modelPath: resolve(root, 'packages/model/src/index.ts') });
  const output = { browser: browser.version(), ...result };
  const reportDirectory = resolve(root, 'packages/model/reports');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(resolve(reportDirectory, 'font-metrics-browser.json'), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ browser: output.browser, samples: result.samples, maxError: result.maxError, wrapSamples: result.wrapSamples, wrapMismatches: result.wrapMismatches }));
  if (result.maxError > 0.1 || result.wrapMismatches !== 0) process.exitCode = 1;
} finally { await browser.close(); }
