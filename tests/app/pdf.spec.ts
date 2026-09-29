import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from '@whiteboard/model';
import coverage from '../../packages/app/src/export-font-coverage.generated.json' with { type: 'json' };

const directory = resolve('docs/benchmarks/phase4/pdf-fonts');
const text = 'Plan €•…— Ā 日本語 end';
const fixture = (['Inter', 'IBM Plex Mono'] as const).flatMap((fontFamily, font) =>
  (['center', 'right'] as const).map((align, row) => createElement('text', {
    id: `${font}-${align}`, index: `a${font * 2 + row}`, x: 70, y: 60 + (font * 2 + row) * 90, w: 850, h: 55,
    style: { fontFamily, fontSize: 32, color: '#111111' }, props: { text, align, autoSize: false },
  })));

test('PDF uses exact shipped cmap fallback and loaded measurement fonts for centered and right mixed text', async ({ page }) => {
  test.setTimeout(60_000); mkdirSync(directory, { recursive: true });
  for (const face of Object.values(coverage)) expect(createHash('sha256').update(readFileSync(resolve('packages/app/public/fonts', face.file))).digest('hex')).toBe(face.sha256);
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { external.push(url.href); return route.abort(); }
    // Troika/fetch can read the shipped WOFF. A cold CSS fallback cannot mask missing PDF font readiness.
    if (route.request().resourceType() === 'font' && url.pathname.includes('noto-sans-jp')) return route.abort();
    return route.continue();
  });
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const outputs = await page.evaluate(async ({ fixture, text }) => {
    const { board, exporter } = window.whiteboard;
    for (const element of fixture) board.add(element);
    const fontWasReady = document.fonts.check('32px "Noto Sans JP"', text);
    const options = { scale: 2, transparent: false, title: 'Mixed PDF font regression' };
    const bytes = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];
    const first = await bytes(await exporter.create({ ...options, format: 'pdf' }));
    const readyFaces = [...document.fonts].filter(face => ['Inter', 'IBM Plex Mono', 'Noto Sans JP'].includes(face.family.replaceAll('"', '')) && face.status === 'loaded').map(face => face.family.replaceAll('"', ''));
    const warm = await bytes(await exporter.create({ ...options, format: 'pdf' }));
    const png = await bytes(await exporter.create({ ...options, format: 'png' }));
    const svg = await exporter.create({ ...options, format: 'svg' });
    const svgText = await svg.text(), parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    // Chrome's SVG-as-image rasterizer needs the embedded faces decoded in this document too.
    for (const [, family, data] of (parsed.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)) document.fonts.add(await new FontFace(family!, `url(${data})`).load());
    const image = new Image(), url = URL.createObjectURL(svg); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width * 2; canvas.height = image.height * 2;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url);
    return { first, warm, png, svg: svgText, svgRaster: canvas.toDataURL(), width: canvas.width, height: canvas.height, fontWasReady, readyFaces };
  }, { fixture, text });
  writeFileSync(`${directory}/cold.pdf`, Buffer.from(outputs.first));
  writeFileSync(`${directory}/warm.pdf`, Buffer.from(outputs.warm));
  writeFileSync(`${directory}/projection.png`, Buffer.from(outputs.png));
  writeFileSync(`${directory}/reference.svg`, outputs.svg);
  writeFileSync(`${directory}/reference.png`, Buffer.from(outputs.svgRaster.split(',')[1]!, 'base64'));
  expect(outputs.fontWasReady).toBe(false);
  expect(outputs.readyFaces).toEqual(expect.arrayContaining(['Inter', 'IBM Plex Mono', 'Noto Sans JP']));
  expect(errors).toEqual([]); expect(external).toEqual([]);

  if (process.env.VERIFY_PDF === '1') {
    const report = execFileSync('python3', ['-c', String.raw`
import fitz,json,sys
from pathlib import Path
root=Path(sys.argv[1]); expected=sys.argv[2]
def read(name):
 d=fitz.open(root/name); p=d[0]; pix=p.get_pixmap(matrix=fitz.Matrix(8/3,8/3),alpha=False); pix.save(root/(name+'.png'))
 lines=[]
 for block in p.get_text('dict')['blocks']:
  for line in block.get('lines',[]):
   spans=line['spans']; lines.append({'text':''.join(s['text'] for s in spans),'spans':[{'text':s['text'],'font':s['font'],'origin':s['origin'],'bbox':s['bbox']} for s in spans]})
 return pix,lines
cold,lines=read('cold.pdf'); warm,warm_lines=read('warm.pdf'); reference=fitz.Pixmap(str(root/'reference.png')); projection=fitz.Pixmap(str(root/'projection.png'))
def ink_bounds(pix,y0,y1):
 data=pix.samples; points=[]
 for y in range(max(0,y0),min(pix.height,y1)):
  for x in range(pix.width):
   at=(y*pix.width+x)*pix.n
   if max(data[at:at+3])<160: points.append((x,y))
 return None if not points else [min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]
regions=[]
for i in range(4):
 y0=20+i*180;y1=180+i*180
 a=ink_bounds(cold,y0,y1);b=ink_bounds(reference,y0,y1);c=ink_bounds(projection,y0,y1)
 regions.append({'row':i,'pdfInk':a,'svgInk':b,'pngInk':c,'maxInkBoundsDelta':max(abs(x-y) for x,y in zip(a,b)) if a and b else None,'pngSvgInkBoundsDelta':max(abs(x-y) for x,y in zip(b,c)) if b and c else None})
print(json.dumps({'lines':lines,'warmLines':warm_lines,'coldWarmPixelsEqual':cold.samples==warm.samples,'pdfSize':[cold.width,cold.height],'svgSize':[reference.width,reference.height],'regions':regions},ensure_ascii=False))
`, directory, text], { env: { ...process.env, PYTHONPATH: process.env.PDF_PYTHONPATH ?? '/private/tmp/whiteboard-pdf' }, encoding: 'utf8' });
    writeFileSync(`${directory}/inspection.json`, report);
    const inspected = JSON.parse(report) as { lines: { text: string; spans: { text: string; font: string }[] }[]; coldWarmPixelsEqual: boolean; regions: { row: number; maxInkBoundsDelta: number | null; pngSvgInkBoundsDelta: number | null }[] };
    expect(inspected.lines.map(line => line.text)).toEqual([text, text, text, text]);
    for (const [index, line] of inspected.lines.entries()) {
      expect(line.spans.filter(span => span.text.includes('Ā') || span.text.includes('日本語')).every(span => span.font.replaceAll(' ', '').includes('NotoSansJP'))).toBe(true);
      const punctuation = line.spans.find(span => span.text.includes('€•…—'))!;
      expect(punctuation.font.replaceAll(' ', '')).toContain(index < 2 ? 'Inter' : 'IBMPlexMono');
      expect(line.spans.at(-1)!.font.replaceAll(' ', '')).toContain('NotoSansJP');
    }
    expect(inspected.coldWarmPixelsEqual).toBe(true);
    for (const region of inspected.regions) {
      expect(region.maxInkBoundsDelta).not.toBeNull(); expect(region.maxInkBoundsDelta!, `PDF row ${region.row}`).toBeLessThanOrEqual(2);
      expect(region.pngSvgInkBoundsDelta).not.toBeNull(); expect(region.pngSvgInkBoundsDelta!, `PNG row ${region.row}`).toBeLessThanOrEqual(2);
    }
  }
});

test('PDF reports unsupported glyphs instead of silently dropping them and remains usable', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, exporter } = window.whiteboard;
    const element = board.create('text', { props: { text: 'Unsupported 🦄', align: 'left', autoSize: true } });
    let error = ''; try { await exporter.create({ format: 'pdf', scale: 1, transparent: false, title: 'Unsupported' }); } catch (cause) { error = String(cause); }
    board.update(element.id, { props: { text: '日本語 €•…— Ā\nLatin after fallback', align: 'left', autoSize: true } });
    const valid = await exporter.create({ format: 'pdf', scale: 1, transparent: false, title: 'Supported' });
    const svg = await exporter.create({ format: 'svg', scale: 1, transparent: false, title: 'Supported' });
    const root = new DOMParser().parseFromString(await svg.text(), 'image/svg+xml');
    return { error, type: valid.type, size: valid.size, secondLineFamily: root.querySelectorAll('text > tspan')[1]?.querySelector('tspan')?.getAttribute('font-family') };
  });
  expect(result.error).toContain('U+1F984'); expect(result.type).toBe('application/pdf'); expect(result.size).toBeGreaterThan(1000); expect(result.secondLineFamily).toBe('Noto Sans JP');
});

test('a malformed PDF font response is evicted so retry fetches the repaired font', async ({ page }) => {
  let requests = 0;
  await page.route('**/fonts/inter-latin-400-normal.ttf', route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 200, contentType: 'font/ttf', body: 'invalid font bytes' }) : route.continue();
  });
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, exporter } = window.whiteboard;
    board.create('text', { props: { text: 'Retry after repaired font', align: 'left', autoSize: true } });
    const options = { format: 'pdf' as const, scale: 1, transparent: false, title: 'Font recovery' };
    let failed = false; try { await exporter.create(options); } catch { failed = true; }
    const repaired = await exporter.create(options);
    return { failed, type: repaired.type, size: repaired.size };
  });
  expect(result.failed).toBe(true); expect(requests).toBe(2);
  expect(result.type).toBe('application/pdf'); expect(result.size).toBeGreaterThan(1000);
});
