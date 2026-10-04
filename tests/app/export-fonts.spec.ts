import { test, expect } from '@playwright/test';
import type { BoardDocument } from '@whiteboard/model';
import type { BoardExporter } from '../../packages/app/src/export';

const cases = [
  { name: 'Latin Inter', text: 'Latin text', family: 'Inter', expected: ['Inter'], stems: ['inter-latin-400-normal.woff'] },
  { name: 'Latin Mono', text: 'Monospace text', family: 'IBM Plex Mono', expected: ['IBM Plex Mono'], stems: ['ibm-plex-mono-latin-400-normal.woff'] },
  { name: 'Japanese and following fallback line', text: '日本語\nLatin after fallback', family: 'Inter', expected: ['Noto Sans JP'], stems: ['noto-sans-jp-400.woff'] },
  { name: 'mixed Mono and Japanese', text: 'Mono 日本語', family: 'IBM Plex Mono', expected: ['IBM Plex Mono', 'Noto Sans JP'], stems: ['ibm-plex-mono-latin-400-normal.woff', 'noto-sans-jp-400.woff'] },
  { name: 'empty sticky', text: '', family: 'Inter', expected: [], stems: [] },
];
for (const fixture of cases) test(`SVG embeds and fetches only used fonts: ${fixture.name}`, async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'fetch' && request.url().endsWith('.woff')) requests.push(request.url().split('/').at(-1)!); });
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async fixture => {
    const Document = window.whiteboard.board.constructor as typeof BoardDocument;
    const Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const board = new Document(), exporter = new Exporter(board);
    try {
      board.create('sticky', { w: 450, h: 180, style: { fontFamily: fixture.family }, props: { text: fixture.text, align: 'left', autoSize: false } });
      const svg = await exporter.create({ format: 'svg', scale: 1, transparent: false, title: fixture.name });
      const source = await svg.text(), root = new DOMParser().parseFromString(source, 'image/svg+xml');
      const css = root.querySelector('style')?.textContent ?? '';
      return { fonts: [...css.matchAll(/@font-face\{font-family:'([^']+)'/g)].map(match => match[1]).sort(), text: root.querySelector('text')?.textContent ?? '', bytes: svg.size };
    } finally { exporter.destroy(); board.destroy(); }
  }, fixture);
  expect(result.fonts).toEqual([...fixture.expected].sort());
  expect(requests.sort()).toEqual([...fixture.stems].sort());
  expect(result.text).toBe(fixture.text.replaceAll('\n', ''));
  if (!fixture.expected.includes('Noto Sans JP')) expect(result.bytes).toBeLessThan(100_000);
});
