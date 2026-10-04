import { expect, test } from '@playwright/test';
import { createElement, textBlock, textLayout } from '@whiteboard/model';
import type { ThreeRenderer } from '@whiteboard/renderer';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory } from '../evidence';
import { pdfInspectionEnvironment } from '../pdf-inspection';

const specifications = [
  ...(['rect', 'ellipse'] as const).flatMap(type => (['left', 'center', 'right'] as const).flatMap(align => (['top', 'middle', 'bottom'] as const).map(verticalAlign => ({ type, align, verticalAlign, text: 'HI', fontSize: 32, fontFamily: 'Inter', w: 240, h: 150, rotation: 0 })))),
  { type: 'ellipse' as const, align: 'center' as const, verticalAlign: 'middle' as const, text: 'Rotated 日本語', fontSize: 28, fontFamily: 'Inter', w: 240, h: 150, rotation: .3 },
  { type: 'rect' as const, align: 'left' as const, verticalAlign: 'middle' as const, text: 'wrapped 日本語 wrapped label', fontSize: 28, fontFamily: 'Inter', w: 140, h: 150, rotation: 0 },
  { type: 'rect' as const, align: 'center' as const, verticalAlign: 'middle' as const, text: 'MMM\nMMM\nMMM', fontSize: 48, fontFamily: 'Inter', w: 160, h: 64, rotation: 0 },
  { type: 'rect' as const, align: 'center' as const, verticalAlign: 'middle' as const, text: 'Inter ABC 日本語', fontSize: 24, fontFamily: 'Inter', w: 240, h: 150, rotation: 0 },
  { type: 'ellipse' as const, align: 'center' as const, verticalAlign: 'middle' as const, text: 'Mono 123 日本語', fontSize: 24, fontFamily: 'IBM Plex Mono', w: 240, h: 150, rotation: 0 },
  ...(['rect', 'ellipse'] as const).map(type => ({ type, align: 'center' as const, verticalAlign: 'bottom' as const, text: 'hidden 日本語\nretained', fontSize: 32, fontFamily: 'Inter', w: 24, h: 24, rotation: 0 })),
];
const fixtures = specifications.map((specification, i) => {
  const element = createElement(specification.type, { id: `label-${String(i).padStart(2, '0')}`, x: 170 + i % 3 * 300 - specification.w / 2, y: 130 + Math.floor(i / 3) * 220 - specification.h / 2, w: specification.w, h: specification.h, rotation: specification.rotation,
    style: { fill: '#66ccff', color: '#111111', strokeWidth: 0, fontSize: specification.fontSize, fontFamily: specification.fontFamily }, props: { text: specification.text, align: specification.align, autoSize: false, verticalAlign: specification.verticalAlign } });
  return { element, block: textBlock(element)!, layout: textLayout(element), region: { x: 20 + i % 3 * 300, y: 20 + Math.floor(i / 3) * 220, w: 300, h: 220 } };
});
const width = 940, height = Math.ceil(fixtures.length / 3) * 220 + 40;
function save(directory: string, name: string, data: string): void { writeFileSync(`${directory}/${name}.png`, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')); }

test('shape SVG and PDF preserve canvas and PNG layout, clipped ink and mixed shipped fonts', async ({ page }, testInfo) => {
  test.setTimeout(90_000); test.skip(process.env.VERIFY_PDF !== '1', 'Requires independent PDF raster and text inspection.');
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async ({ fixtures, width, height }) => {
    const { board, exporter } = window.whiteboard;
    board.create('rect', { id: 'frame', x: 0, y: 0, w: width, h: height, style: { fill: 'transparent', strokeWidth: 0 } });
    for (const { element } of fixtures) board.add(element);
    const Renderer = window.whiteboard.renderer.constructor as typeof ThreeRenderer, canvas = document.createElement('canvas');
    const renderer = new Renderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff', fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', background: '#ffffff', pixelRatio: 1 });
    renderer.resize(width, height); renderer.setCamera({ x: width / 2, y: height / 2, zoom: 1 });
    const inspect = (source: CanvasImageSource, scale: number) => {
      const raster = document.createElement('canvas'); raster.width = width * scale; raster.height = height * scale;
      const paint = raster.getContext('2d')!; paint.drawImage(source, 0, 0, raster.width, raster.height); const pixels = paint.getImageData(0, 0, raster.width, raster.height).data;
      const regions = fixtures.map(({ element, block, region }) => {
        let count = 0, outside = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const cos = Math.cos(element.rotation), sin = Math.sin(element.rotation), cx = element.x + element.w / 2, cy = element.y + element.h / 2;
        for (let y = Math.max(0, Math.floor(region.y * scale)); y < Math.min(raster.height, Math.ceil((region.y + region.h) * scale)); y++) for (let x = Math.max(0, Math.floor(region.x * scale)); x < Math.min(raster.width, Math.ceil((region.x + region.w) * scale)); x++) {
          const at = (y * raster.width + x) * 4; if (Math.max(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) >= 160) continue;
          const px = (x + .5) / scale, py = (y + .5) / scale, dx = px - cx, dy = py - cy;
          const localX = cx + cos * dx + sin * dy - element.x, localY = cy - sin * dx + cos * dy - element.y;
          if (localX < block.insetX - 1 || localX > element.w - block.insetX + 1 || localY < block.insetY - 1 || localY > element.h - block.insetY + 1) outside++;
          count++; minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
        return { count, outside, bounds: count ? [minX, minY, maxX, maxY] : null };
      });
      return { regions, raster: raster.toDataURL() };
    };
    try {
      renderer.setElements(board.readAll()); await renderer.whenReady(); renderer.render(); const screen = inspect(canvas, 1);
      const options = { padding: 0, transparent: false, title: 'Shape label parity' }, png = [];
      for (const scale of [1, 2]) { const bitmap = await createImageBitmap(await exporter.create({ ...options, format: 'png', scale })); try { png.push(inspect(bitmap, scale)); } finally { bitmap.close(); } }
      const svg = await (await exporter.create({ ...options, format: 'svg', scale: 1 })).text(), parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const fonts = [...(parsed.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)].map(match => ({ family: match[1]!, data: match[2]! }));
      for (const font of fonts) document.fonts.add(await new FontFace(font.family, `url(${font.data})`).load());
      const metadata = fixtures.map(({ element }) => {
        const group = [...parsed.querySelectorAll('g[data-element-id]')].find(node => node.getAttribute('data-element-id') === element.id)!;
        const text = group.querySelector('text'), label = text?.parentElement;
        return { id: element.id, text: text?.textContent, x: Number(text?.getAttribute('x')), y: Number(text?.getAttribute('y')), hidden: label?.getAttribute('display'), clip: label?.getAttribute('clip-path') };
      });
      const svgBlob = new Blob([svg], { type: 'image/svg+xml' }), url = URL.createObjectURL(svgBlob), image = new Image();
      image.src = url; await image.decode(); const svgPixels = [inspect(image, 1), inspect(image, 2)]; URL.revokeObjectURL(url);
      const overflow = renderer.getTextObject('label-20')!, originalClip = overflow.clipRect;
      overflow.clipRect = null; renderer.render(); const unclippedCanvas = inspect(canvas, 1); overflow.clipRect = originalClip; renderer.render();
      const unclipped = parsed.cloneNode(true) as Document;
      [...unclipped.querySelectorAll('g[data-element-id]')].find(node => node.getAttribute('data-element-id') === 'label-20')?.querySelector('g[clip-path]')?.removeAttribute('clip-path');
      const negativeUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(unclipped)], { type: 'image/svg+xml' })), negativeImage = new Image();
      negativeImage.src = negativeUrl; await negativeImage.decode(); const unclippedSvg = inspect(negativeImage, 1); URL.revokeObjectURL(negativeUrl);

      const pdf = [...new Uint8Array(await (await exporter.create({ ...options, format: 'pdf', scale: 1 })).arrayBuffer())];
      const selectedSvg = await (await exporter.create({ ...options, format: 'svg', selection: ['label-22'], scale: 1 })).text();
      const selectedPdf = [...new Uint8Array(await (await exporter.create({ ...options, format: 'pdf', selection: ['label-22'], scale: 1 })).arrayBuffer())];
      return { screen, png, svgPixels, unclippedCanvas, unclippedSvg, svg, metadata, fonts: fonts.map(font => font.family), pdf, selectedSvg, selectedPdf };
    } finally { renderer.dispose(); }
  }, { fixtures, width, height });
  const directory = evidenceDirectory(testInfo); save(directory, 'screen', result.screen.raster); for (let i = 0; i < 2; i++) { save(directory, `png${i + 1}`, result.png[i]!.raster); save(directory, `svg${i + 1}`, result.svgPixels[i]!.raster); }
  writeFileSync(`${directory}/shapes.svg`, result.svg); writeFileSync(`${directory}/shapes.pdf`, Buffer.from(result.pdf)); writeFileSync(`${directory}/selected.svg`, result.selectedSvg); writeFileSync(`${directory}/selected.pdf`, Buffer.from(result.selectedPdf));
  save(directory, 'unclipped-canvas-control', result.unclippedCanvas.raster); save(directory, 'unclipped-svg-control', result.unclippedSvg.raster);
  expect(result.unclippedCanvas.regions[20]!.outside).toBeGreaterThan(20); expect(result.unclippedSvg.regions[20]!.outside).toBeGreaterThan(20);
  expect(result.fonts).toEqual(expect.arrayContaining(['Inter', 'IBM Plex Mono', 'Noto Sans JP']));
  for (const [index, metadata] of result.metadata.entries()) {
    const { element, block, layout } = fixtures[index]!;
    expect(metadata.text).toBe(layout.lines.map(line => line.text).join(''));
    expect(metadata.x).toBeCloseTo(element.x + (block.align === 'left' ? block.insetX : block.align === 'right' ? element.w - block.insetX : element.w / 2), 4);
    expect(metadata.y).toBeCloseTo(element.y + block.insetY + layout.verticalOffset! + element.style.fontSize, 4);
    expect(metadata.clip).toMatch(/^url\(#shape-label-clip-\d+\)$/);
    const empty = element.w <= block.insetX * 2 || element.h <= block.insetY * 2;
    if (empty) expect(metadata.hidden).toBe('none');
    for (const projection of [result.screen, ...result.png, ...result.svgPixels]) {
      const region = projection.regions[index]!; expect(region.outside, `${element.id} clip`).toBe(0);
      if (empty) expect(region.count, `${element.id} empty box`).toBe(0);
      else { expect(region.count, `${element.id} ink`).toBeGreaterThan(20); for (let component = 0; component < 4; component++) expect(Math.abs(region.bounds![component]! - result.screen.regions[index]!.bounds![component]!)).toBeLessThanOrEqual(1); }
    }
  }
  const report = JSON.parse(execFileSync('python3', ['-c', String.raw`
import fitz,json,sys
from pathlib import Path
root=Path(sys.argv[1]); fixtures=json.loads(sys.argv[2]); doc=fitz.open(root/'shapes.pdf'); page=doc[0]; pix=page.get_pixmap(matrix=fitz.Matrix(8/3,8/3),alpha=False); pix.save(root/'pdf2.png'); data=pix.samples
regions=[]
for case in fixtures:
 e,b,r=case['element'],case['block'],case['region']; points=[];outside=0
 import math
 c,s=math.cos(e['rotation']),math.sin(e['rotation']); cx,cy=e['x']+e['w']/2,e['y']+e['h']/2
 for y in range(max(0,int(r['y']*2)),min(pix.height,math.ceil((r['y']+r['h'])*2))):
  for x in range(max(0,int(r['x']*2)),min(pix.width,math.ceil((r['x']+r['w'])*2))):
   at=(y*pix.width+x)*pix.n
   if max(data[at:at+3])>=160:continue
   px,py=(x+.5)/2,(y+.5)/2;dx,dy=px-cx,py-cy;lx,ly=cx+c*dx+s*dy-e['x'],cy-s*dx+c*dy-e['y']
   if lx<b['insetX']-1 or lx>e['w']-b['insetX']+1 or ly<b['insetY']-1 or ly>e['h']-b['insetY']+1:outside+=1
   points.append((px,py))
 regions.append({'count':len(points),'outside':outside,'bounds':None if not points else [min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]})
selected=fitz.open(root/'selected.pdf');selected[0].get_pixmap(matrix=fitz.Matrix(8/3,8/3),alpha=False).save(root/'selected-pdf2.png')
print(json.dumps({'regions':regions,'text':page.get_text(),'fonts':[row[3] for row in page.get_fonts()],'size':[pix.width,pix.height],'selectedText':selected[0].get_text()},ensure_ascii=False))
`, directory, JSON.stringify(fixtures)], { encoding: 'utf8', env: pdfInspectionEnvironment() }));
  writeFileSync(`${directory}/comparison.json`, JSON.stringify({ metadata: result.metadata, fonts: result.fonts, negativeControls: { canvasOutside: result.unclippedCanvas.regions[20]!.outside, svgOutside: result.unclippedSvg.regions[20]!.outside }, screen: result.screen.regions, png: result.png.map(image => image.regions), svg: result.svgPixels.map(image => image.regions), pdf: report }, null, 2));
  expect(report.size).toEqual([width * 2, height * 2]); expect(report.text.replace(/\s+/g, ' ')).toContain('Inter ABC 日本語'); expect(report.text.replace(/\s+/g, ' ')).toContain('Mono 123 日本語');
  expect(report.fonts).toEqual(expect.arrayContaining(['Inter', 'IBM Plex Mono', 'Noto Sans JP']));
  for (const [index, region] of report.regions.entries()) {
    expect(region.outside, `${fixtures[index]!.element.id} PDF clip`).toBe(0);
    const reference = result.png[1]!.regions[index]!;
    if (!reference.count) expect(region.count).toBe(0);
    else { expect(region.count).toBeGreaterThan(20); for (let component = 0; component < 4; component++) expect(Math.abs(region.bounds[component] - reference.bounds![component]!)).toBeLessThanOrEqual(1); }
  }
  expect(result.selectedSvg).toContain('Mono'); expect(result.selectedSvg).not.toContain('Inter ABC'); expect(report.selectedText.replace(/\s+/g, ' ')).toContain('Mono 123 日本語'); expect(report.selectedText).not.toContain('Inter ABC');
});

test('hidden shape labels retain stored text, warn nonblockingly and fail strict PDF coverage', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => { const board = window.whiteboard.board; board.create('ellipse', { id: 'hidden-unsupported', w: 24, h: 24 }); board.setShapeText('hidden-unsupported', '\u{F0000}'); });
  await expect(page.getByRole('alert')).toContainText('U+F0000');
  const outcome = await page.evaluate(async () => {
    const { board, exporter } = window.whiteboard;
    const svg = await (await exporter.create({ format: 'svg', scale: 1, transparent: false, title: 'Hidden source' })).text();
    let error = ''; try { await exporter.create({ format: 'pdf', scale: 1, transparent: false, title: 'Missing font' }); } catch (value) { error = value instanceof Error ? value.message : String(value); }
    return { props: board.read('hidden-unsupported')!.props, svg, error };
  });
  expect(outcome.props).toMatchObject({ text: '\u{F0000}' }); expect(outcome.svg).toContain('\u{F0000}'); expect(outcome.svg).toContain('display="none"'); expect(outcome.error).toContain('PDF export has no shipped font for U+F0000');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.evaluate(() => window.whiteboard.board.move(['hidden-unsupported'], { x: 10, y: 10 })); await expect(page.getByRole('alert')).toHaveCount(0);
});


test('XML-invalid stored fields fail cleanly without changing source or history and exports can recover', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, exporter } = window.whiteboard;
    board.create('rect', { id: 'malformed-label', w: 24, h: 24 }); board.setShapeText('malformed-label', '\u0000\u{F0000}');
    const errors = async () => {
      const before = JSON.stringify(board.readAll()), history = board.undoManager.undoStack.length, failures: string[] = [];
      for (const format of ['svg', 'pdf'] as const) {
        try { await exporter.create({ format, scale: 1, transparent: false, title: 'XML validation' }); failures.push('resolved'); }
        catch (value) { failures.push(value instanceof Error ? value.message : String(value)); }
      }
      return { failures, unchanged: before === JSON.stringify(board.readAll()), historyUnchanged: history === board.undoManager.undoStack.length };
    };
    const text = await errors(); board.setShapeText('malformed-label', 'Recovered');
    board.create('rect', { id: 'invalid-id\u0000', x: 100, y: 100 }); const id = await errors(); board.delete(['invalid-id\u0000']);
    const title: string[] = []; const beforeTitle = JSON.stringify(board.readAll()), beforeHistory = board.undoManager.undoStack.length;
    for (const format of ['svg', 'pdf'] as const) {
      try { await exporter.create({ format, scale: 1, transparent: false, title: 'bad\u0000title' }); title.push('resolved'); }
      catch (value) { title.push(value instanceof Error ? value.message : String(value)); }
    }
    const titleUnchanged = beforeTitle === JSON.stringify(board.readAll()) && beforeHistory === board.undoManager.undoStack.length;
    const svg = await (await exporter.create({ format: 'svg', scale: 1, transparent: false, title: 'Recovered' })).text();
    const pdf = await exporter.create({ format: 'pdf', scale: 1, transparent: false, title: 'Recovered' });
    return { text, id, title, titleUnchanged, recoveredText: new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('text')?.textContent, pdfType: pdf.type, pdfSize: pdf.size };
  });
  expect(result.text.failures[0]).toContain('valid XML'); expect(result.text.failures[1]).toContain('PDF export has no shipped font for U+0000');
  for (const message of [...result.id.failures, ...result.title]) expect(message).toContain('valid XML');
  for (const state of [result.text, result.id]) { expect(state.unchanged).toBe(true); expect(state.historyUnchanged).toBe(true); }
  expect(result.titleUnchanged).toBe(true); expect(result.recoveredText).toBe('Recovered'); expect(result.pdfType).toBe('application/pdf'); expect(result.pdfSize).toBeGreaterThan(1000);
});


test('self-translucent shape labels composite glyph interiors equally across live, PNG, SVG and PDF', async ({ page }, testInfo) => {
  test.skip(process.env.VERIFY_PDF !== '1', 'Requires independent PDF pixel inspection.');
  const elements = (['rect', 'ellipse'] as const).map((type, index) => createElement(type, { id: `self-alpha-${type}`, x: 20 + index * 220, y: 20, w: 200, h: 160, style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 48, opacity: .5 }, props: { text: 'HI', align: 'center', autoSize: false, verticalAlign: 'middle' } }));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async elements => {
    const { board, exporter } = window.whiteboard; elements.forEach(element => board.add(element));
    const Renderer = window.whiteboard.renderer.constructor as typeof ThreeRenderer, canvas = document.createElement('canvas');
    const renderer = new Renderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff', fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', background: '#ffffff', pixelRatio: 1 });
    renderer.resize(460, 200); renderer.setCamera({ x: 230, y: 100, zoom: 1 });
    const raster = (source: CanvasImageSource) => { const output = document.createElement('canvas'); output.width = 460; output.height = 200; const paint = output.getContext('2d')!; paint.drawImage(source, 0, 0); return { output, paint, pixels: paint.getImageData(0, 0, 460, 200).data }; };
    try {
      renderer.setElements(elements.map(element => ({ ...element, style: { ...element.style, opacity: 1 } }))); await renderer.whenReady(); renderer.render();
      const opaque = raster(canvas), probes = elements.map(element => {
        for (let y = element.y; y < element.y + element.h; y++) for (let x = element.x; x < element.x + element.w; x++) {
          const at = (y * 460 + x) * 4; if (opaque.pixels[at] === 0 && opaque.pixels[at + 1] === 0 && opaque.pixels[at + 2] === 0) return [x, y];
        }
        throw new Error('No solid glyph interior found.');
      });
      renderer.applyDiff(elements); renderer.render(); const screen = raster(canvas);
      const options = { scale: 1, transparent: false, padding: 20, title: 'Self alpha' }, bitmap = await createImageBitmap(await exporter.create({ ...options, format: 'png' }));
      const png = raster(bitmap); bitmap.close();
      const svg = await (await exporter.create({ ...options, format: 'svg' })).text(), parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      for (const [, family, data] of (parsed.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)) document.fonts.add(await new FontFace(family!, `url(${data})`).load());
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), image = new Image(); image.src = url; await image.decode(); const svgRaster = raster(image); URL.revokeObjectURL(url);
      const samples = (image: typeof screen) => probes.map(([x, y]) => [...image.paint.getImageData(x!, y!, 1, 1).data]);
      const pdf = [...new Uint8Array(await (await exporter.create({ ...options, format: 'pdf' })).arrayBuffer())];
      return { probes, screen: samples(screen), png: samples(png), svg: samples(svgRaster), pdf, screenRaster: screen.output.toDataURL(), pngRaster: png.output.toDataURL(), svgRaster: svgRaster.output.toDataURL() };
    } finally { renderer.dispose(); }
  }, elements);
  const directory = evidenceDirectory(testInfo); for (const name of ['screenRaster', 'pngRaster', 'svgRaster'] as const) save(directory, name, result[name]);
  const pdf = `${directory}/self-alpha.pdf`; writeFileSync(pdf, Buffer.from(result.pdf));
  const pdfColors = JSON.parse(execFileSync('python3', ['-c', 'import fitz,json,sys; doc=fitz.open(sys.argv[1]); p=doc[0].get_pixmap(matrix=fitz.Matrix(4/3,4/3),alpha=False); p.save(sys.argv[2]); print(json.dumps([list(p.pixel(x,y))+[255] for x,y in json.loads(sys.argv[3])]))', pdf, `${directory}/pdfRaster.png`, JSON.stringify(result.probes)], { encoding: 'utf8', env: pdfInspectionEnvironment() }));
  writeFileSync(`${directory}/colors.json`, JSON.stringify({ probes: result.probes, screen: result.screen, png: result.png, svg: result.svg, pdf: pdfColors }, null, 2));
  for (const format of [result.png, result.svg, pdfColors]) for (let i = 0; i < 2; i++) for (let channel = 0; channel < 4; channel++) expect(Math.abs(format[i]![channel]! - result.screen[i]![channel]!)).toBeLessThanOrEqual(2);
});
