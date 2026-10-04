import { test, expect } from '@playwright/test';
import type { BoardDocument } from '@whiteboard/model';
import type { BoardExporter } from '../../packages/app/src/export';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { png, fixture } from '../png-fixtures';
import { evidenceDirectory } from '../evidence';
import { pdfInspectionEnvironment } from '../pdf-inspection';

// These legal PNGs are built without the decoder being tested. jsPDF's direct
// 16-bit alpha path swaps sample bytes in both fast-png 6 and 8.
test('16-bit gray-alpha and RGBA images retain browser pixels in PDF and original bytes in SVG', async ({ page }, testInfo) => {
  test.skip(process.env.VERIFY_PDF !== '1', 'Requires the independent PDF raster verifier.');
  const sources = ([4, 6] as const).map(type => [...png(type, 16, fixture(type, 16))]);
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async sources => {
    const Document = window.whiteboard.board.constructor as typeof BoardDocument, Exporter = window.whiteboard.exporter.constructor as typeof BoardExporter;
    const board = new Document(), urls: string[] = [], expected: number[][][] = [];
    for (const [index, bytes] of sources.entries()) {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' }); urls.push(URL.createObjectURL(blob));
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = canvas.height = 80;
      const paint = canvas.getContext('2d')!; paint.fillStyle = 'white'; paint.fillRect(0, 0, 80, 80); paint.drawImage(bitmap, 0, 0, 80, 80); bitmap.close();
      expected.push(Array.from({ length: 4 }, (_, i) => [...paint.getImageData(i % 2 ? 60 : 20, i >= 2 ? 60 : 20, 1, 1).data]));
      board.create('image', { id: `alpha-${index}`, x: index * 100, y: 0, w: 80, h: 80, style: { strokeWidth: 0 }, props: { assetId: String(index), naturalW: 2, naturalH: 2 } });
    }
    const exporter = new Exporter(board, id => urls[Number(id)]!);
    try {
      const options = { scale: 1, transparent: false, padding: 0, title: '16-bit alpha PNG' };
      const svg = await (await exporter.create({ ...options, format: 'svg' })).text();
      const embedded = [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('image')].map(node => {
        const uri = node.getAttribute('href') ?? node.getAttribute('xlink:href')!;
        return [...Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), c => c.charCodeAt(0))];
      });
      const pdf = [...new Uint8Array(await (await exporter.create({ ...options, format: 'pdf' })).arrayBuffer())];
      return { expected, embedded, pdf };
    } finally { exporter.destroy(); board.destroy(); urls.forEach(url => URL.revokeObjectURL(url)); }
  }, sources);
  expect(result.embedded).toEqual(sources);
  const file = `${evidenceDirectory(testInfo)}/alpha16.pdf`; writeFileSync(file, Buffer.from(result.pdf));
  const actual = JSON.parse(execFileSync('python3', ['-c', 'import fitz,json,sys; doc=fitz.open(sys.argv[1]); p=doc[0].get_pixmap(matrix=fitz.Matrix(4/3,4/3),alpha=False); p.save(sys.argv[2]); print(json.dumps([[list(p.pixel(n*100+(60 if i%2 else 20),60 if i>=2 else 20))+[255] for i in range(4)] for n in range(2)]))', file, `${evidenceDirectory(testInfo)}/alpha16-raster.png`], { encoding: 'utf8', env: pdfInspectionEnvironment() }));
  for (let n = 0; n < 2; n++) for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) expect(Math.abs(actual[n][i][c] - result.expected[n]![i]![c]!)).toBeLessThanOrEqual(3);
});
