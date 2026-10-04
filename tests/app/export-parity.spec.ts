import { test, expect } from '@playwright/test';
import { readImageHeader, type BoardDocument } from '@whiteboard/model';
import type { BoardExporter } from '../../packages/app/src/export';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evidenceDirectory } from '../evidence';
import { pdfInspectionEnvironment } from '../pdf-inspection';

for (const format of ['png', 'svg', 'pdf'] as const) test(`legacy EXIF rotations and mirrors retain display orientation in ${format.toUpperCase()}`, async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async format => {
    const Document = window.whiteboard.board.constructor as typeof BoardDocument, Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const board = new Document(), source = document.createElement('canvas'); source.width = 80; source.height = 40;
    const context = source.getContext('2d')!;
    for (const [i, color] of ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].entries()) { context.fillStyle = color; context.fillRect(i % 2 * 40, Math.floor(i / 2) * 20, 40, 20); }
    const jpeg = new Uint8Array(await (await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), 'image/jpeg', 1))).arrayBuffer());
    const urls: string[] = [], expected: number[][][] = [], positions: number[][] = [];
    for (let orientation = 2; orientation <= 8; orientation++) {
      const tiff = new Uint8Array(26), view = new DataView(tiff.buffer);
      tiff.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 1, true);
      view.setUint16(10, 0x112, true); view.setUint16(12, 3, true); view.setUint32(14, 1, true); view.setUint16(18, orientation, true);
      const app = Uint8Array.from([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, ...tiff]);
      const bytes = new Uint8Array(jpeg.length + app.length); bytes.set(jpeg.subarray(0, 2)); bytes.set(app, 2); bytes.set(jpeg.subarray(2), 2 + app.length);
      const blob = new Blob([bytes], { type: 'image/jpeg' }), url = URL.createObjectURL(blob); urls.push(url);
      const bitmap = await createImageBitmap(blob), reference = document.createElement('canvas'); reference.width = bitmap.width; reference.height = bitmap.height;
      const paint = reference.getContext('2d')!; paint.drawImage(bitmap, 0, 0); bitmap.close();
      expected.push(Array.from({ length: 4 }, (_, i) => [...paint.getImageData(reference.width * (i % 2 ? .75 : .25), reference.height * (i >= 2 ? .75 : .25), 1, 1).data]));
      positions.push([reference.width, reference.height]);
      board.create('image', { id: `orientation-${orientation}`, x: (orientation - 2) * 100, y: 0, w: reference.width, h: reference.height, props: { assetId: String(orientation - 2), naturalW: reference.width, naturalH: reference.height } });
    }
    const exporter = new Exporter(board, id => urls[Number(id)]!);
    try {
      const blob = await exporter.create({ format, scale: 1, transparent: false, padding: 0, title: 'EXIF parity' });
      const bytes = [...new Uint8Array(await blob.arrayBuffer())];
      if (format === 'pdf') return { bytes, expected, positions, actual: null, embeddedTypes: null };
      let image: CanvasImageSource, url: string | undefined;
      if (format === 'svg') { url = URL.createObjectURL(blob); const decoded = new Image(); decoded.src = url; await decoded.decode(); image = decoded; }
      else image = await createImageBitmap(blob);
      const output = document.createElement('canvas'); output.width = 680; output.height = 80;
      const paint = output.getContext('2d')!; paint.drawImage(image, 0, 0); if (image instanceof ImageBitmap) image.close(); if (url) URL.revokeObjectURL(url);
      const actual = positions.map(([w, h], n) => Array.from({ length: 4 }, (_, i) => [...paint.getImageData(n * 100 + w! * (i % 2 ? .75 : .25), h! * (i >= 2 ? .75 : .25), 1, 1).data]));
      const embeddedTypes = format === 'svg' ? [...new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').querySelectorAll('image')].map(node => node.getAttribute('href') ?? node.getAttribute('xlink:href')) : null;
      return { bytes, expected, positions, actual, embeddedTypes };
    } finally { exporter.destroy(); board.destroy(); urls.forEach(url => URL.revokeObjectURL(url)); }
  }, format);
  // Independently check the browser reference against all seven EXIF transforms.
  const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
  const order = [[1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1], [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2]];
  for (let n = 0; n < order.length; n++) for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) expect(Math.abs(result.expected[n]![i]![c]! - colors[order[n]![i]!]![c]!)).toBeLessThanOrEqual(3);
  if (result.embeddedTypes) for (const source of result.embeddedTypes) expect(source).toMatch(/^data:image\/png;/);
  let actual = result.actual;
  if (format === 'pdf' && process.env.VERIFY_PDF === '1') {
    const file = `${evidenceDirectory(testInfo)}/exif.pdf`; writeFileSync(file, Buffer.from(result.bytes));
    actual = JSON.parse(execFileSync('python3', ['-c', 'import fitz,json,sys; p=fitz.open(sys.argv[1])[0].get_pixmap(matrix=fitz.Matrix(4/3,4/3)); dims=json.loads(sys.argv[2]); print(json.dumps([[list(p.pixel(int(n*100+w*(.75 if i%2 else .25)),int(h*(.75 if i>=2 else .25))))+[255] for i in range(4)] for n,(w,h) in enumerate(dims)]))', file, JSON.stringify(result.positions)], { encoding: 'utf8', env: pdfInspectionEnvironment() }));
  }
  if (actual) for (let n = 0; n < actual.length; n++) for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) expect(Math.abs(actual[n]![i]![c]! - result.expected[n]![i]![c]!)).toBeLessThanOrEqual(3);
});

test('PNG retains committed tiny text at both scales while the screen keeps its text LOD', async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, renderer, exporter } = window.whiteboard;
    board.create('text', { id: 'tiny', x: 0, y: 0, w: 80, h: 20, style: { fontSize: 4, color: '#000000' }, props: { text: 'Tiny committed text', align: 'left', autoSize: false } });
    renderer.render(); const screenVisible = renderer.stats().visibleTexts;
    const inks: number[] = [];
    for (const scale of [1, 2]) {
      const blob = await exporter.create({ format: 'png', scale, padding: 0, transparent: false, title: 'Tiny text' });
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const paint = canvas.getContext('2d')!; paint.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = paint.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 240) ink++; inks.push(ink);
    }
    const svg = await (await exporter.create({ format: 'svg', scale: 1, padding: 0, transparent: false, title: 'Tiny text' })).text();
    const pdf = [...new Uint8Array(await (await exporter.create({ format: 'pdf', scale: 1, padding: 0, transparent: false, title: 'Tiny text' })).arrayBuffer())];
    return { screenVisible, inks, svg, pdf };
  });
  expect(result.screenVisible).toBe(0); for (const ink of result.inks) expect(ink).toBeGreaterThan(0);
  expect(result.svg).toContain('Tiny committed text');
  if (process.env.VERIFY_PDF === '1') {
    const file = `${evidenceDirectory(testInfo)}/tiny.pdf`; writeFileSync(file, Buffer.from(result.pdf));
    expect(execFileSync('python3', ['-c', 'import fitz,sys; print(fitz.open(sys.argv[1])[0].get_text())', file], { encoding: 'utf8', env: pdfInspectionEnvironment() })).toContain('Tiny committed text');
  }
});


test('oriented uploads bake EXIF into pixels before uploading a single model gesture', async ({ page }) => {
  const uploads: { bytes: number[]; type: string }[] = [];
  await page.route('**/api/boards/local/assets', async route => {
    const bytes = route.request().postDataBuffer()!, header = readImageHeader(bytes);
    uploads.push({ bytes: [...bytes], type: route.request().headers()['content-type']! });
    await route.fulfill({ json: { assetId: `uploaded-${uploads.length}`, width: header.width, height: header.height } });
  });
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const before = await page.evaluate(async () => {
    const source = document.createElement('canvas'); source.width = 80; source.height = 40;
    const paint = source.getContext('2d')!; paint.fillStyle = '#ff0000'; paint.fillRect(0, 0, 40, 40); paint.fillStyle = '#0000ff'; paint.fillRect(40, 0, 40, 40);
    const jpeg = new Uint8Array(await (await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), 'image/jpeg', 1))).arrayBuffer());
    const files: File[] = [];
    for (const orientation of [2, 6]) {
      const tiff = new Uint8Array(26), view = new DataView(tiff.buffer);
      tiff.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 1, true);
      view.setUint16(10, 0x112, true); view.setUint16(12, 3, true); view.setUint32(14, 1, true); view.setUint16(18, orientation, true);
      const app = Uint8Array.from([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, ...tiff]);
      const bytes = new Uint8Array(jpeg.length + app.length); bytes.set(jpeg.subarray(0, 2)); bytes.set(app, 2); bytes.set(jpeg.subarray(2), 2 + app.length);
      files.push(new File([bytes], `orientation-${orientation}.jpg`, { type: 'image/jpeg' }));
    }
    const before = window.whiteboard.board.undoManager.undoStack.length;
    await window.whiteboard.assets.importFiles(files);
    return before;
  });
  expect(uploads).toHaveLength(2);
  for (const upload of uploads) { expect(upload.type).toBe('image/png'); expect(readImageHeader(new Uint8Array(upload.bytes)).orientation).toBeUndefined(); }
  const samples = await page.evaluate(async uploads => {
    const results: number[][][] = [];
    for (const upload of uploads) {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(upload.bytes)], { type: upload.type }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const paint = canvas.getContext('2d')!; paint.drawImage(bitmap, 0, 0); bitmap.close();
      results.push([[...paint.getImageData(canvas.width / 4, canvas.height / 4, 1, 1).data], [...paint.getImageData(canvas.width * .75, canvas.height * .75, 1, 1).data]]);
    }
    return results;
  }, uploads);
  expect(samples[0]![0]![2]).toBeGreaterThan(250); expect(samples[0]![1]![0]).toBeGreaterThan(250);
  expect(samples[1]![0]![0]).toBeGreaterThan(250); expect(samples[1]![1]![2]).toBeGreaterThan(250);
  expect(await page.evaluate(() => window.whiteboard.board.readAll().map(element => element.type === 'image' ? [element.props.naturalW, element.props.naturalH] : null))).toEqual([[80, 40], [40, 80]]);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(before + 1);
  await page.evaluate(() => window.whiteboard.board.undoManager.undo());
  expect(await page.evaluate(() => window.whiteboard.board.readAll())).toEqual([]);
});
