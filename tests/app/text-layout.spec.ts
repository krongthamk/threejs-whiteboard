import { pdfInspectionEnvironment } from '../pdf-inspection';
import { test, expect } from '@playwright/test';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createElement, resolveFontRuns, textLayout, type ShippedFontFamily } from '@whiteboard/model';

test.afterEach(({}, testInfo) => recordBrowserEvidence(testInfo, 'docs/benchmarks/phase4/mixed-text-layout'));
const samples = ['日本語 WWWWWWWWWW', '日本語\nWWWWWWWWWW', 'Latin Ā WWW\n日本語 WWW', '日本語 office affinity ffi fl fi', 'カタカナ。ひらがな、日本語！', 'A\u0304V 日本語 ＷＷＷ'];
const fixtures = (['Inter', 'IBM Plex Mono'] as const).flatMap(fontFamily => [24, 48].flatMap(fontSize => samples.map((text, index) => createElement('text', {
  id: `${fontFamily}-${fontSize}-${index}`, x: -300, y: -100, style: { fontFamily, fontSize, color: '#111111' }, props: { text, align: 'left', autoSize: true },
}))));
const cases = [...fixtures, ...(['Inter', 'IBM Plex Mono'] as const).map(fontFamily => createElement('text', {
  id: `wrap-${fontFamily}`, x: -300, y: -100, w: 130, h: 240, style: { fontFamily, fontSize: 32 }, props: { text: '日本語 WWWWWWWW\nWWWWWWWW', align: 'left', autoSize: false },
}))].map(element => {
  const layout = textLayout(element); let previousFont: ShippedFontFamily | undefined;
  const lines = layout.lines.map(line => { const runs = resolveFontRuns(line.text, element.style.fontFamily, { previousFont }); previousFont = runs.at(-1)?.family ?? previousFont; return { ...line, runs }; });
  return { element, layout, lines };
});

test('actual Troika and browser glyph widths match deterministic mixed-script auto-size and wrapping', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const directory = evidenceDirectory(testInfo);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const measured = await page.evaluate(async cases => {
    for (const [family, file] of [['Inter', 'inter-latin-400-normal.woff'], ['IBM Plex Mono', 'ibm-plex-mono-latin-400-normal.woff'], ['Noto Sans JP', 'noto-sans-jp-400.woff']]) document.fonts.add(await new FontFace(family!, `url(/fonts/${file})`).load());
    const context = document.createElement('canvas').getContext('2d')!; context.fontKerning = 'normal';
    const { board, renderer } = window.whiteboard, measured = [];
    for (const { element, layout, lines } of cases) {
      board.add(element); await renderer.whenReady();
      const object = renderer.getTextObject(element.id)!, bounds = object.textRenderInfo!.blockBounds;
      const widths = lines.map(line => {
        let browser = 0;
        for (const run of line.runs) { context.font = `${element.style.fontSize}px "${run.family}"`; browser += context.measureText(run.text).width; }
        return { text: line.text, expected: line.width, browser, error: Math.abs(browser - line.width), families: line.runs.map(run => run.family) };
      });
      measured.push({ id: element.id, model: board.read(element.id), renderedText: object.text, expectedText: layout.text, troikaWidth: bounds[2] - bounds[0], expectedWidth: Math.max(...lines.map(line => line.width)), widths });
      board.delete([element.id]);
    }
    return measured;
  }, cases);
  writeFileSync(`${directory}/widths.json`, JSON.stringify({ measured, pageErrors: errors }, null, 2));
  expect(measured).toHaveLength(26);
  for (const sample of measured) {
    expect(sample.renderedText, sample.id).toBe(sample.expectedText);
    expect(Math.abs(sample.troikaWidth - sample.expectedWidth), sample.id).toBeLessThan(.1);
    for (const line of sample.widths) {
      if (/[。、！]/u.test(line.text)) expect(line.browser, 'Native default punctuation is deliberately different; SVG uses explicit positions').toBeGreaterThan(line.expected + 20);
      else expect(line.error, `${sample.id}: ${line.text}`).toBeLessThan(.1);
    }
  }
  expect(errors).toEqual([]);
});

test('native mixed-script IME, caret and reopen preserve text; committed auto-size exports all glyphs', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const directory = evidenceDirectory(testInfo);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const cdp = await page.context().newCDPSession(page), outputs = [];
  for (const fontFamily of ['Inter', 'IBM Plex Mono']) {
    await page.evaluate(fontFamily => {
      const { board, textEditor } = window.whiteboard;
      board.create('text', { id: 'draft', x: -300, y: -100, style: { fontFamily, fontSize: 32, color: '#111111' }, props: { text: 'Start', align: 'left', autoSize: true } });
      board.undoManager.clear(); textEditor.open('draft');
    }, fontFamily);
    const input = page.getByRole('textbox', { name: 'Edit text' }); await expect(input).toBeFocused();
    await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
    expect(await page.evaluate(() => window.whiteboard.board.read('draft')!.props)).toMatchObject({ text: 'Start' });
    await cdp.send('Input.insertText', { text: '日本語' });
    await page.keyboard.type(' WWWWWWWWWWWW！'); await page.keyboard.press('Enter'); await page.keyboard.type('WWWWWWWWWWWW');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('WWWW');
    await page.keyboard.press('ArrowRight'); await page.keyboard.type('。');
    const native = await input.evaluate(element => {
      const node = element as HTMLElement, range = getSelection()!.getRangeAt(0), caret = range.getBoundingClientRect(), box = node.getBoundingClientRect();
      return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, caretInInput: caret.left >= box.left - 1 && caret.right <= box.right + 1 && caret.top >= box.top - 1 && caret.bottom <= box.bottom + 1, overflow: getComputedStyle(node).overflow };
    });
    expect(native.scrollWidth).toBeLessThanOrEqual(native.clientWidth + 1); expect(native.scrollHeight).toBeLessThanOrEqual(native.clientHeight + 1); expect(native.caretInInput).toBe(true); expect(native.overflow).toBe('visible');
    await page.keyboard.press('ControlOrMeta+Enter'); await expect(input).toHaveCount(0);
    const text = '日本語 WWWWWWWWWWWW！\nWWWWWWWWWWWW。';
    const committed = await page.evaluate(async () => { await window.whiteboard.renderer.whenReady(); return { element: window.whiteboard.board.read('draft')!, undo: window.whiteboard.board.undoManager.undoStack.length }; });
    expect(committed.element.props).toMatchObject({ text }); expect(committed.undo).toBe(1);
    const expected = createElement('text', { style: { fontFamily, fontSize: 32 }, props: { text, align: 'left', autoSize: true } });
    expect(committed.element.w).toBeCloseTo(expected.w, 8); expect(committed.element.h).toBe(80);
    await page.evaluate(() => window.whiteboard.textEditor.open('draft')); await expect(input).toBeFocused();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(text);
    await page.keyboard.press('ControlOrMeta+Enter'); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
    const rendered = await page.evaluate(async () => {
      const { board, exporter } = window.whiteboard, element = board.read('draft')!;
      const options = { scale: 2, transparent: false, title: 'Mixed-script complete text' };
      const png = await exporter.create({ ...options, format: 'png' }), svg = await exporter.create({ ...options, format: 'svg' }), pdf = await exporter.create({ ...options, format: 'pdf' });
      const svgText = await svg.text(), parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      for (const [, family, url] of (parsed.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)) document.fonts.add(await new FontFace(family!, `url(${url})`).load());
      const bitmap = await createImageBitmap(png), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close(); const left = context.getImageData(0, 0, canvas.width, canvas.height).data, pngUrl = canvas.toDataURL();
      const raster = async (source: string) => { const image = new Image(), url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' })); image.src = url; await image.decode(); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, Number(parsed.documentElement.getAttribute('width')) * 2, Number(parsed.documentElement.getAttribute('height')) * 2); URL.revokeObjectURL(url); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
      const right = await raster(svgText), svgRaster = canvas.toDataURL();
      const compare = (other: Uint8ClampedArray) => [0, 1].map(row => {
        let a: number[] | null = null, b: number[] | null = null, foreground = 0, mismatch = 0;
        const ink = (bounds: number[] | null, x: number, y: number) => bounds ? [Math.min(bounds[0]!, x), Math.min(bounds[1]!, y), Math.max(bounds[2]!, x), Math.max(bounds[3]!, y)] : [x, y, x, y];
        const differs = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => [0, 1, 2].some(c => Math.abs(a[ai + c]! - b[bi + c]!) > 48);
        const nearby = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!differs(a, ai, b, bi + (dy * canvas.width + dx) * 4)) return true; return false; };
        for (let y = 48 + row * 80; y < 48 + (row + 1) * 80; y++) for (let x = 1; x < canvas.width - 1; x++) {
          const at = (y * canvas.width + x) * 4;
          if (Math.max(left[at]!, left[at + 1]!, left[at + 2]!) < 160) a = ink(a, x, y);
          if (Math.max(other[at]!, other[at + 1]!, other[at + 2]!) < 160) b = ink(b, x, y);
          if ([0, 1, 2].some(c => left[at + c]! < 245 || other[at + c]! < 245)) { foreground++; if (!nearby(left, at, other, at) || !nearby(other, at, left, at)) mismatch++; }
        }
        return { row, pngInk: a, svgInk: b, maxInkDelta: a && b ? Math.max(...a.map((value, index) => Math.abs(value - b![index]!))) : null, mismatch: mismatch / Math.max(1, foreground), foreground };
      });
      const positive = compare(right), negative = compare(await raster(svgText.replaceAll('font-family="Noto Sans JP"', 'font-family="IBM Plex Mono"')));
      return { element, pngUrl, svgText, svgRaster, pdf: [...new Uint8Array(await pdf.arrayBuffer())], width: canvas.width, height: canvas.height, positive, negative, families: [...parsed.querySelectorAll('text > tspan > tspan')].map(span => span.getAttribute('font-family')) };
    });
    const stem = fontFamily.replaceAll(' ', '-');
    writeFileSync(`${directory}/${stem}.png`, Buffer.from(rendered.pngUrl.split(',')[1]!, 'base64')); writeFileSync(`${directory}/${stem}.svg`, rendered.svgText); writeFileSync(`${directory}/${stem}-svg.png`, Buffer.from(rendered.svgRaster.split(',')[1]!, 'base64'));
    writeFileSync(`${directory}/${stem}.pdf`, Buffer.from(rendered.pdf));
    outputs.push({ fontFamily, native, ...rendered, pdf: undefined, pngUrl: undefined, svgText: undefined, svgRaster: undefined });
    writeFileSync(`${directory}/editing-export.json`, JSON.stringify({ outputs, channelTolerance: 48, edgeAllowanceCssPixels: .5, inkBoundsToleranceOutputPixels: 1, maxForegroundMismatch: .18, nativeTypography: 'Native browser fallback intentionally may return to primary Latin while committed Troika retains Noto; no native glyph pixel parity is asserted.', errors }, null, 2));
    expect(rendered.families.length).toBeGreaterThan(2); expect(rendered.families.every(family => family === 'Noto Sans JP')).toBe(true);
    for (const row of rendered.positive) { expect(row.foreground).toBeGreaterThan(100); expect(row.maxInkDelta).not.toBeNull(); expect(row.maxInkDelta!).toBeLessThanOrEqual(1); expect(row.mismatch).toBeLessThan(.18); expect(row.pngInk![2]!).toBeLessThan(rendered.width - 10); }
    for (const row of rendered.negative) expect(row.maxInkDelta === null || row.maxInkDelta > 1 || row.mismatch > .18).toBe(true);
    if (process.env.VERIFY_PDF === '1') {
      const inspection = JSON.parse(execFileSync('python3', ['-c', String.raw`
import fitz,json,sys
from pathlib import Path
root=Path(sys.argv[1]);stem=sys.argv[2]
doc=fitz.open(root/(stem+'.pdf'));page=doc[0];pdf=page.get_pixmap(matrix=fitz.Matrix(8/3,8/3),alpha=False);pdf.save(root/(stem+'-pdf.png'));svg=fitz.Pixmap(str(root/(stem+'-svg.png')))
def ink(pix,row):
 data=pix.samples;points=[]
 for y in range(48+row*80,min(pix.height,48+(row+1)*80)):
  for x in range(pix.width):
   at=(y*pix.width+x)*pix.n
   if max(data[at:at+3])<160:points.append((x,y))
 return [min(x for x,y in points),min(y for x,y in points),max(x for x,y in points),max(y for x,y in points)]
print(json.dumps({'text':page.get_text(),'rows':[{'pdf':ink(pdf,row),'svg':ink(svg,row),'delta':max(abs(a-b) for a,b in zip(ink(pdf,row),ink(svg,row)))} for row in range(2)]},ensure_ascii=False))
`, directory, stem], { env: pdfInspectionEnvironment(), encoding: 'utf8' }));
      writeFileSync(`${directory}/${stem}-pdf.json`, JSON.stringify(inspection, null, 2));
      expect(inspection.text.replaceAll('\n', '')).toBe(text.replaceAll('\n', ''));
      for (const row of inspection.rows) expect(row.delta).toBeLessThanOrEqual(2);
    }
    await page.evaluate(() => window.whiteboard.board.delete(['draft']));
  }
  expect(errors).toEqual([]);
});

test('repeated Noto Latin ligatures keep PNG SVG and PDF widths without cumulative clipping', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const directory = evidenceDirectory(testInfo);
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const text = `日本語 ${Array(8).fill('office affinity ffi ffl fffi').join(' ')}`;
  const output = await page.evaluate(async text => {
    const { board, exporter } = window.whiteboard;
    board.create('text', { style: { fontFamily: 'IBM Plex Mono', fontSize: 32, color: '#111111' }, props: { text, align: 'left', autoSize: true } });
    const options = { scale: 2, transparent: false, title: 'Repeated Noto ligatures' };
    const svg = await exporter.create({ ...options, format: 'svg' }), png = await exporter.create({ ...options, format: 'png' }), pdf = await exporter.create({ ...options, format: 'pdf' });
    const source = await svg.text(), parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    for (const [, family, data] of (parsed.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)) document.fonts.add(await new FontFace(family!, `url(${data})`).load());
    const width = Number(parsed.documentElement.getAttribute('width')), height = Number(parsed.documentElement.getAttribute('height'));
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(width * 2); canvas.height = Math.ceil(height * 2);
    const context = canvas.getContext('2d')!, image = new Image(), url = URL.createObjectURL(svg); image.src = url; await image.decode();
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, width * 2, height * 2); URL.revokeObjectURL(url);
    return { png: [...new Uint8Array(await png.arrayBuffer())], pdf: [...new Uint8Array(await pdf.arrayBuffer())], svg: source, raster: canvas.toDataURL(), width: canvas.width, height: canvas.height };
  }, text);
  writeFileSync(`${directory}/ligatures.png`, Buffer.from(output.png)); writeFileSync(`${directory}/ligatures.pdf`, Buffer.from(output.pdf)); writeFileSync(`${directory}/ligatures.svg`, output.svg); writeFileSync(`${directory}/ligatures-svg.png`, Buffer.from(output.raster.split(',')[1]!, 'base64'));
  if (process.env.VERIFY_PDF === '1') {
    const inspection = JSON.parse(execFileSync('python3', ['-c', String.raw`
import fitz,json,sys
from pathlib import Path
root=Path(sys.argv[1]);doc=fitz.open(root/'ligatures.pdf');page=doc[0];pdf=page.get_pixmap(matrix=fitz.Matrix(8/3,8/3),alpha=False);pdf.save(root/'ligatures-pdf.png');svg=fitz.Pixmap(str(root/'ligatures-svg.png'));png=fitz.Pixmap(str(root/'ligatures.png'))
def bounds(pix):
 data=pix.samples;left=pix.width;right=0;top=pix.height;bottom=0
 for y in range(pix.height):
  for x in range(pix.width):
   at=(y*pix.width+x)*pix.n
   if max(data[at:at+3])<160:left=min(left,x);right=max(right,x);top=min(top,y);bottom=max(bottom,y)
 return [left,top,right,bottom]
a=bounds(png);b=bounds(svg);c=bounds(pdf)
def compare(left,right):
 a=left.samples;b=right.samples;foreground=0;mismatch=0;w=min(left.width,right.width);h=min(left.height,right.height)
 def differs(a,ai,b,bi):return any(abs(a[ai+c]-b[bi+c])>48 for c in range(3))
 def nearby(a,ai,b,bi,pix):
  return any(not differs(a,ai,b,bi+(dy*pix.width+dx)*pix.n)for dy in range(-1,2)for dx in range(-1,2))
 for y in range(1,h-1):
  for x in range(1,w-1):
   ai=(y*left.width+x)*left.n;bi=(y*right.width+x)*right.n
   if min(a[ai:ai+3])>=245 and min(b[bi:bi+3])>=245:continue
   foreground+=1
   if differs(a,ai,b,bi) and (not nearby(a,ai,b,bi,right)or not nearby(b,bi,a,ai,left)):mismatch+=1
 return {'foreground':foreground,'edgeTolerantMismatch':mismatch/max(1,foreground)}
print(json.dumps({'text':page.get_text(),'png':a,'svg':b,'pdf':c,'pngSvgDelta':max(abs(x-y)for x,y in zip(a,b)),'pdfSvgDelta':max(abs(x-y)for x,y in zip(c,b)),'pngSvg':compare(png,svg),'pdfSvg':compare(pdf,svg),'pageWidth':pdf.width,'pageHeight':pdf.height},ensure_ascii=False))
`, directory], { env: pdfInspectionEnvironment(), encoding: 'utf8' }));
    writeFileSync(`${directory}/ligatures.json`, JSON.stringify(inspection, null, 2));
    expect(inspection.text.trim()).toBe(text); expect(inspection.pngSvgDelta).toBeLessThanOrEqual(1); expect(inspection.pdfSvgDelta).toBeLessThanOrEqual(2); expect(inspection.pdf[2]).toBeLessThan(inspection.pageWidth - 10);
    expect(inspection.pngSvg.edgeTolerantMismatch).toBeLessThan(.18); expect(inspection.pdfSvg.edgeTolerantMismatch).toBeLessThan(.18);
  }
});

for (const scenario of ['offscreen', 'onscreen', 'presence'] as const) test(`cold and warm production PNG exports retain wide text with ${scenario} atlas generation`, async ({ page }, testInfo) => {
  test.setTimeout(90_000); const directory = evidenceDirectory(testInfo);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const measured = await page.evaluate(async scenario => {
    const { board, exporter, renderer } = window.whiteboard;
    const text = `日本語 ${Array(8).fill('office affinity ffi ffl fffi').join(' ')}`;
    const visibleOnScreen = scenario === 'onscreen';
    const element = board.create('text', { id: 'wide-export', x: visibleOnScreen ? 0 : 30_000, y: visibleOnScreen ? 0 : 12_000, style: { fontFamily: 'IBM Plex Mono', fontSize: 32, color: '#111111' }, props: { text, align: 'left', autoSize: true } });
    if (scenario === 'presence') {
      renderer.setPresence([{ clientId: 'cold-atlas-peer', name: text.slice(0, 80), color: '#4678ca', cursor: { x: 0, y: 0 }, selection: [] }]);
      renderer.render();
    }
    await exporter.create({ format: 'svg', scale: 2, transparent: false, title: 'Prime export fonts' });
    const before = { display: renderer.stats(), textReady: !!renderer.getTextObject(element.id)?.textRenderInfo };
    const results = [];
    for (const label of ['cold', 'warm']) {
      const blob = await exporter.create({ format: 'png', scale: 2, transparent: false, title: 'Wide cold export' });
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0, left = canvas.width, top = canvas.height, right = -1, bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const at = (y * canvas.width + x) * 4;
        if (Math.max(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) < 160) { ink++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
      }
      const projection = (exporter as unknown as { renderer: typeof renderer }).renderer, object = projection.getTextObject(element.id);
      results.push({ label, ink, bounds: [left, top, right, bottom], width: canvas.width, height: canvas.height, image: canvas.toDataURL(), projection: projection.stats(), text: object ? { visible: object.visible, parent: object.parent?.name, blockBounds: object.textRenderInfo?.blockBounds } : null });
    }
    return { element, before, results, display: renderer.stats() };
  }, scenario);
  const stem = `wide-export-${scenario}`;
  for (const result of measured.results) writeFileSync(`${directory}/${stem}-${result.label}.png`, Buffer.from(result.image.split(',')[1]!, 'base64'));
  writeFileSync(`${directory}/${stem}.json`, JSON.stringify({ ...measured, results: measured.results.map(({ image: _image, ...result }) => result), pageErrors: errors }, null, 2));
  expect(measured.element.w).toBeGreaterThan(2500);
  for (const result of measured.results) {
    expect(result.ink, result.label).toBeGreaterThan(1000);
    expect(result.bounds[0], result.label).toBeGreaterThanOrEqual(48);
    expect(result.bounds[2], result.label).toBeGreaterThan(result.width - 100);
    expect(result.bounds[2], result.label).toBeLessThan(result.width - 10);
  }
  expect(measured.results[0]!.bounds).toEqual(measured.results[1]!.bounds);
  expect(measured.results[0]!.ink).toBe(measured.results[1]!.ink);
  expect(errors).toEqual([]);
});
