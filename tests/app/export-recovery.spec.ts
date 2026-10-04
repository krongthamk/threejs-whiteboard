import { test, expect } from '@playwright/test';
import type { BoardDocument } from '@whiteboard/model';
import type { BoardExporter } from '../../packages/app/src/export';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evidenceDirectory } from '../evidence';
import { pdfInspectionEnvironment } from '../pdf-inspection';

test('busy PDF close prevents late downloads and permits a new export', async ({ page }) => {
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/fonts/*.ttf', async route => { requested(); await gate; await route.continue().catch(() => {}); });
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => window.whiteboard.board.create('text', { props: { text: 'Cancel this export', align: 'left', autoSize: true } }));
  await page.getByRole('button', { name: 'Export board', exact: true }).click();
  await page.getByRole('button', { name: 'PDF Document', exact: true }).click();
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click(); await started;
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  release();
  await expect.poll(() => downloads.length).toBe(0);
  // A second request on the same exporter must work after the cancelled consumer settles.
  await page.getByRole('button', { name: 'Export board', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click(); await download;
  expect(downloads).toEqual([expect.stringMatching(/\.png$/)]);
});

for (const format of ['png', 'svg', 'pdf'] as const) test(`failed image instances become placeholders with exact asset warnings in ${format.toUpperCase()}`, async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async format => {
    const Document = window.whiteboard.board.constructor as typeof BoardDocument, Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const board = new Document(), source = document.createElement('canvas'); source.width = source.height = 10;
    const paint = source.getContext('2d')!; paint.fillStyle = '#00ff00'; paint.fillRect(0, 0, 10, 10);
    const exporter = new Exporter(board, id => id === 'valid' ? source.toDataURL() : id === 'bad' ? 'data:image/png;base64,AAAA' : Promise.reject(new Error('Missing source')));
    for (const [i, assetId] of ['valid', 'valid', 'missing', 'missing', 'bad'].entries()) board.create('image', { id: `image-${i}`, x: i * 30, y: 0, w: 24, h: 24, props: { assetId, naturalW: i === 1 ? 11 : 10, naturalH: 10 } });
    let warnings: readonly string[] = [];
    const options = { format, scale: 1, transparent: false, title: 'Partial export', padding: 0, onAssetWarnings: (ids: readonly string[]) => { warnings = ids; } };
    try {
      const blob = await exporter.create(options), data = [...new Uint8Array(await blob.arrayBuffer())];
      if (format === 'pdf') return { warnings, data, pixels: null, images: null };
      let image: CanvasImageSource;
      let url: string | undefined;
      if (format === 'svg') { url = URL.createObjectURL(blob); const svgImage = new Image(); svgImage.src = url; await svgImage.decode(); image = svgImage; }
      else image = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 24;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); if (image instanceof ImageBitmap) image.close(); if (url) URL.revokeObjectURL(url);
      return { warnings, data, pixels: Array.from({ length: 5 }, (_, i) => [...context.getImageData(i * 30 + 12, 12, 1, 1).data]), images: format === 'svg' ? new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').querySelectorAll('image').length : null };
    } finally { exporter.destroy(); board.destroy(); }
  }, format);
  expect(result.warnings).toEqual(['bad', 'missing', 'valid']);
  const expected = [[0, 255, 0, 255], ...Array.from({ length: 4 }, () => [254, 226, 226, 255])];
  if (result.pixels) expect(result.pixels).toEqual(expected);
  if (format === 'svg') expect(result.images).toBe(1);
  if (format === 'pdf' && process.env.VERIFY_PDF === '1') {
    const file = `${evidenceDirectory(testInfo)}/partial.pdf`; writeFileSync(file, Buffer.from(result.data));
    const pixels = JSON.parse(execFileSync('python3', ['-c', 'import fitz,json,sys; p=fitz.open(sys.argv[1])[0].get_pixmap(matrix=fitz.Matrix(4/3,4/3)); print(json.dumps([list(p.pixel(i*30+12,12))+[255] for i in range(5)]))', file], { encoding: 'utf8', env: pdfInspectionEnvironment() }));
    for (let i = 0; i < expected.length; i++) for (let c = 0; c < 4; c++) expect(Math.abs(pixels[i][c] - expected[i]![c]!)).toBeLessThanOrEqual(1); // PDF color conversion rounds by one channel unit.
  }
});


test('native dialog close clears React state and restores the invoking control', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const button = page.getByRole('button', { name: 'Export board', exact: true }); await button.click();
  await page.evaluate(() => document.querySelector('dialog')!.close());
  await expect(page.locator('dialog')).toHaveCount(0); await expect(button).toBeFocused();
  await button.click(); await expect(page.getByRole('dialog')).toBeVisible();
});

for (const format of ['png', 'svg', 'pdf'] as const) test(`cancelled ${format.toUpperCase()} asset resolution rejects promptly without publishing a warning`, async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async format => {
    const Document = window.whiteboard.board.constructor as typeof BoardDocument, Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const board = new Document(), canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
    let finish!: (url: string) => void, warnings = 0;
    const exporter = new Exporter(board, () => new Promise<string>(resolve => { finish = resolve; }));
    board.create('image', { props: { assetId: 'delayed', naturalW: 10, naturalH: 10 } });
    const controller = new AbortController();
    const options = { format, scale: 1, transparent: false, title: 'Cancelled asset', signal: controller.signal, onAssetWarnings: () => warnings++ };
    const pending = exporter.create(options); await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    const outcome = await Promise.race([pending.then(() => 'resolved', error => error.name), new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 50))]);
    finish(canvas.toDataURL()); await pending.catch(() => {}); exporter.destroy(); board.destroy();
    return { outcome, warnings };
  }, format);
  expect(result.outcome).toBe('AbortError'); expect(result.warnings).toBe(0);
});

test('a partial download keeps the warning visible in the export dialog', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => window.whiteboard.board.create('image', { props: { assetId: 'missing-visible', naturalW: 10, naturalH: 10 } }));
  await page.getByRole('button', { name: 'Export board', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PNG', exact: true }).click(); await download;
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Exported with placeholders for assets: missing-visible.');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await expect(page.locator('dialog')).toHaveCount(0);
});
