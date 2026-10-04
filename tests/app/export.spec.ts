import { pdfInspectionEnvironment } from '../pdf-inspection';
import { test, expect } from '@playwright/test';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { contentBounds, createElement, getElementBounds } from '@whiteboard/model';
import { mixedFixture } from '../../spikes/text/fixture';

const fixture = [...mixedFixture(), createElement('text', { id: 'japanese', x: 530, y: 350, index: 'a6', style: { fontSize: 28 }, props: { text: '日本語のアイデア', align: 'left', autoSize: true } })];
test.afterEach(({}, testInfo) => recordBrowserEvidence(testInfo, 'docs/benchmarks/phase4'));
test.beforeEach(async ({ page }, testInfo) => { await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard); });

test('document-only selection PNG excludes overlap and draft; all four scales and transparency work', async ({ page }, testInfo) => {
  const result = await page.evaluate(async () => {
    const { board, renderer, exporter } = window.whiteboard;
    const first = board.create('rect', { x: 0, y: 0, w: 100, h: 80, style: { fill: '#ff0000', strokeWidth: 0 } }).id;
    board.create('rect', { x: 0, y: 0, w: 100, h: 80, style: { fill: '#0000ff', strokeWidth: 0 } });
    // A renderer-only pending gesture must not leak into a document export.
    renderer.applyDiff([{ ...board.read(first)!, style: { ...board.read(first)!.style, fill: '#00ff00' } }]);
    const outputs = [];
    for (const scale of [1, 2, 3, 4]) {
      const blob = await exporter.create({ format: 'png', selection: [first], scale, transparent: true, title: 'Selection' });
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      outputs.push({ scale, width: canvas.width, height: canvas.height, corner: [...context.getImageData(0, 0, 1, 1).data], center: [...context.getImageData(50 * scale, 50 * scale, 1, 1).data] });
    }
    return outputs;
  });
  for (const output of result) { expect(output.width).toBe(148 * output.scale); expect(output.height).toBe(128 * output.scale); expect(output.corner).toEqual([0, 0, 0, 0]); expect(output.center).toEqual([255, 0, 0, 255]); }
});

test('mixed Latin/Japanese board exports PNG, embedded SVG and PDF through the real dialog', async ({ page }, testInfo) => {
  test.setTimeout(60_000); const directory = evidenceDirectory(testInfo);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(values => { window.whiteboard.board.transact(() => { for (const element of values) window.whiteboard.board.add(element); }); window.whiteboard.controller.zoomToFit(); }, fixture);
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
  await page.screenshot({ path: `${directory}/application.png` });
  for (const format of ['png', 'svg', 'pdf'] as const) {
    await page.getByRole('button', { name: 'Export board', exact: true }).click();
    await page.getByRole('button', { name: format === 'png' ? 'PNG Image' : format === 'svg' ? 'SVG Scalable vector' : 'PDF Document', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download ${format.toUpperCase()}`, exact: true }).click();
    await (await download).saveAs(`${directory}/mixed.${format}`);
  }
  const bounds = contentBounds(fixture);
  const regions = fixture.map(element => ({ name: element.id, type: element.type, ...getElementBounds(element, new Map(fixture.map(item => [item.id, item]))) }));
  const comparison = await page.evaluate(async ({ bounds, regions }) => {
    const exporter = window.whiteboard.exporter, renderer = window.whiteboard.renderer;
    const options = { scale: 2, transparent: false, title: 'Mixed board' };
    const png = await exporter.create({ ...options, format: 'png' });
    const svg = await exporter.create({ ...options, format: 'svg' });
    const box = { x: bounds.x - 24, y: bounds.y - 24, w: bounds.w + 48, h: bounds.h + 48 };
    const width = Math.ceil(box.w * 2), height = Math.ceil(box.h * 2);
    const svgText = await svg.text();
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const css = doc.querySelector('style')?.textContent ?? '';
    const fonts = [...css.matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)];
    for (const [, family, url] of fonts) document.fonts.add(await new FontFace(family!, `url(${url})`).load());
    const image = new Image(), svgUrl = URL.createObjectURL(svg); image.src = svgUrl; await image.decode();
    const paint = document.createElement('canvas'); paint.width = width; paint.height = height; const context = paint.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, box.w * 2, box.h * 2); const svgPixels = context.getImageData(0, 0, width, height).data, svgRaster = paint.toDataURL(); URL.revokeObjectURL(svgUrl);
    const bitmap = await createImageBitmap(png); context.clearRect(0, 0, width, height); context.drawImage(bitmap, 0, 0); bitmap.close(); const pngPixels = context.getImageData(0, 0, width, height).data;
    renderer.resize(width, height); renderer.setCamera({ x: box.x + width / 4, y: box.y + height / 4, zoom: 2 });
    renderer.webgl.setClearColor('#ffffff'); renderer.layers.grid.visible = false; renderer.layers.selectionUI.visible = false;
    await renderer.whenReady(); renderer.render(); context.clearRect(0, 0, width, height); context.drawImage(renderer.webgl.domElement, 0, 0, width, height);
    const screenPixels = context.getImageData(0, 0, width, height).data, screenRaster = paint.toDataURL();
    const mismatch = (left: Uint8ClampedArray, right: Uint8ClampedArray) => { let different = 0; for (let i = 0; i < left.length; i += 4) if (Math.max(...[0, 1, 2, 3].map(c => Math.abs(left[i + c]! - right[i + c]!))) > 24) different++; return different / (left.length / 4); };
    const regionMismatch = (left: Uint8ClampedArray, right: Uint8ClampedArray, region: typeof regions[number]) => {
      const x0 = Math.max(1, Math.floor((region.x - box.x) * 2) - 2), y0 = Math.max(1, Math.floor((region.y - box.y) * 2) - 2);
      const x1 = Math.min(width - 1, Math.ceil((region.x + region.w - box.x) * 2) + 2), y1 = Math.min(height - 1, Math.ceil((region.y + region.h - box.y) * 2) + 2);
      const differs = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => [0, 1, 2].some(c => Math.abs(a[ai + c]! - b[bi + c]!) > 48);
      const nearby = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!differs(a, ai, b, bi + (dy * width + dx) * 4)) return true;
        return false;
      };
      let foreground = 0, different = 0, edges = 0;
      let inkA: number[] | null = null, inkB: number[] | null = null;
      const ink = (previous: number[] | null, x: number, y: number) => previous ? [Math.min(previous[0]!, x), Math.min(previous[1]!, y), Math.max(previous[2]!, x), Math.max(previous[3]!, y)] : [x, y, x, y];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        if (![0, 1, 2].some(c => left[i + c]! < 245 || right[i + c]! < 245)) continue;
        foreground++;
        if (Math.max(left[i]!, left[i + 1]!, left[i + 2]!) < 160) inkA = ink(inkA, x, y);
        if (Math.max(right[i]!, right[i + 1]!, right[i + 2]!) < 160) inkB = ink(inkB, x, y);
        if (differs(left, i, right, i)) { different++; if (!nearby(left, i, right, i) || !nearby(right, i, left, i)) edges++; }
      }
      return { name: region.name, type: region.type, inkBoundsDifference: inkA && inkB ? Math.max(...inkA.map((value, i) => Math.abs(value - inkB![i]!))) : null, foreground, rawMismatch: different / Math.max(1, foreground), edgeTolerantMismatch: edges / Math.max(1, foreground) };
    };
    const regionChecks = regions.map(region => ({ ...regionMismatch(pngPixels, svgPixels, region), screen: regionMismatch(pngPixels, screenPixels, region) }));
    const negativeControls = [];
    for (const [name, changed] of [['missing Latin', svgText.replace('A shared place to think', '')], ['shifted 1px Latin', svgText.replace('data-element-id="editable"', 'data-element-id="editable" transform="translate(1 0)"')], ['displaced Latin', svgText.replace('data-element-id="editable"', 'data-element-id="editable" transform="translate(8 0)"')], ['missing Japanese', svgText.replace('日本語のアイデア', '')]]) {
      const url = URL.createObjectURL(new Blob([changed!], { type: 'image/svg+xml' })); image.src = url; await image.decode();
      context.clearRect(0, 0, width, height); context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, box.w * 2, box.h * 2); URL.revokeObjectURL(url);
      const region = regions.find(region => region.name === (name!.includes('Japanese') ? 'japanese' : 'editable'))!;
      negativeControls.push({ ...regionMismatch(pngPixels, context.getImageData(0, 0, width, height).data, region), name });
    }
    return { fonts: fonts.length, fontFamilies: fonts.map(([, family]) => family).sort(), embedded: svgText.includes('data:font/woff;base64,'), width, height, pngVsSvg: mismatch(pngPixels, svgPixels), pngVsScreen: mismatch(pngPixels, screenPixels), regions: regionChecks, negativeControls, edgeToleranceCssPixels: .5, channelTolerance: 48, inkMaskMaxChannel: 160, inkBoundsToleranceOutputPixels: 1, svgRaster, screenRaster };
  }, { bounds, regions });
  writeFileSync(`${directory}/svg-raster.png`, Buffer.from(comparison.svgRaster.split(',')[1]!, 'base64'));
  writeFileSync(`${directory}/screen-raster.png`, Buffer.from(comparison.screenRaster.split(',')[1]!, 'base64'));
  writeFileSync(`${directory}/comparison.json`, JSON.stringify({ ...comparison, svgRaster: undefined, screenRaster: undefined, pageErrors: errors }, null, 2));
  expect(comparison.fonts).toBe(2); expect(comparison.fontFamilies).toEqual(['Inter', 'Noto Sans JP']); expect(comparison.embedded).toBe(true);
  expect(comparison.pngVsScreen).toBeLessThan(.01); expect(comparison.pngVsSvg).toBeLessThan(.03);
  for (const region of comparison.regions) { expect(region.foreground, region.name).toBeGreaterThan(100); expect(region.edgeTolerantMismatch, region.name).toBeLessThan(.18); expect(region.screen.edgeTolerantMismatch, region.name).toBeLessThan(.18); if (region.type === 'text' || region.type === 'sticky') { expect(region.inkBoundsDifference, region.name).not.toBeNull(); expect(region.inkBoundsDifference!, region.name).toBeLessThanOrEqual(1); expect(region.screen.inkBoundsDifference!, region.name).toBeLessThanOrEqual(1); } }
  for (const control of comparison.negativeControls) expect(control.edgeTolerantMismatch > .18 || control.inkBoundsDifference === null || control.inkBoundsDifference > 1, control.name).toBe(true);
  expect(errors).toEqual([]);
  if (process.env.VERIFY_PDF === '1') {
    const output = execFileSync('python3', ['-c', 'import fitz,json,sys; d=fitz.open(sys.argv[1]); p=d[0]; p.get_pixmap(matrix=fitz.Matrix(2.6666667,2.6666667)).save(sys.argv[2]); print(json.dumps({"pages":len(d),"text":p.get_text(),"width":p.rect.width,"height":p.rect.height},ensure_ascii=False))', `${directory}/mixed.pdf`, `${directory}/pdf-raster.png`], { env: pdfInspectionEnvironment(), encoding: 'utf8' });
    const inspected = JSON.parse(output); writeFileSync(`${directory}/pdf-inspection.json`, output);
    expect(inspected.pages).toBe(1); expect(inspected.text).toContain('日本語'); expect(inspected.text).toContain('A shared place to think');
  }
});

test('minimap navigates the actual camera and keyboard fit preserves document contents', async ({ page }, testInfo) => {
  await page.evaluate(values => { for (const element of values) window.whiteboard.board.add(element); }, fixture);
  const before = await page.evaluate(() => window.whiteboard.board.readAll());
  await page.getByRole('button', { name: 'Open minimap', exact: true }).click();
  const map = page.getByRole('button', { name: 'Minimap · drag to navigate, Enter to fit board', exact: true });
  await map.click({ position: { x: 120, y: 70 } });
  expect(await page.evaluate(() => window.whiteboard.session.getState().camera.x)).not.toBe(0);
  await map.press('Enter'); expect(await page.evaluate(() => window.whiteboard.board.readAll())).toEqual(before);
  const viewport = page.locator('.minimap-view svg rect');
  const width = Number(await viewport.getAttribute('width'));
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(async () => Number(await viewport.getAttribute('width'))).toBeCloseTo(width * 1200 / 1440, 3);
});
