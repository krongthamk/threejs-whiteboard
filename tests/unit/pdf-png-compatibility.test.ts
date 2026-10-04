import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { png, fixture } from '../png-fixtures';

// Resolve the real dependency from the app package that owns jsPDF.
const appRequire = createRequire(new URL('../../packages/app/package.json', import.meta.url));
const { jsPDF } = appRequire('jspdf');
const { decode } = createRequire(appRequire.resolve('jspdf'))('fast-png');

const width = 2, height = 2;
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 };
const names = { 0: 'gray', 2: 'RGB', 4: 'gray-alpha', 6: 'RGBA' };
function bytes(samples: readonly number[], depth: 8 | 16): Buffer {
  if (depth === 8) return Buffer.from(samples);
  const result = Buffer.alloc(samples.length * 2); samples.forEach((sample, i) => result.writeUInt16BE(sample, i * 2)); return result;
}
function imageObjects(pdf: string): Map<number, { dictionary: string; data: Buffer }> {
  const objects = new Map<number, { dictionary: string; data: Buffer }>();
  for (const match of pdf.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    const body = match[2]!; if (!body.includes('/Subtype /Image')) continue;
    const stream = body.indexOf('stream\n'), dictionary = body.slice(0, stream), length = Number(dictionary.match(/\/Length (\d+)/)?.[1]);
    objects.set(Number(match[1]), { dictionary, data: Buffer.from(body.slice(stream + 7, stream + 7 + length), 'latin1') });
  }
  return objects;
}
const cases = ([0, 2, 4, 6] as const).flatMap(type => ([8, 16] as const).map(depth => ({ type, depth, interlaced: false })));
cases.push({ type: 6, depth: 8, interlaced: true });

test.each(cases)('installed jsPDF decoder preserves $depth-bit PNG color type $type (Adam7: $interlaced)', ({ type, depth, interlaced }) => {
  const pixels = fixture(type, depth), decoded = decode(png(type, depth, pixels, interlaced), { checkCrc: true });
  expect({ width: decoded.width, height: decoded.height, depth: decoded.depth, channels: decoded.channels }).toEqual({ width, height, depth, channels: channels[type] });
  expect([...decoded.data]).toEqual(pixels.flat());
});

// jsPDF 4.2.1 byte-swaps direct 16-bit alpha samples with both fast-png 6.4
// and 8. The application's PDF-only canvas normalization is covered natively.
const supportedEmbedding = cases.filter(({ type, depth }) => depth !== 16 || type === 0 || type === 2);
test.each(supportedEmbedding)('jsPDF embeds $depth-bit PNG color type $type (Adam7: $interlaced) with exact color and alpha samples', ({ type, depth, interlaced }) => {
  const pixels = fixture(type, depth), source = png(type, depth, pixels, interlaced);
  const pdf = new jsPDF({ compress: false, putOnlyUsedFonts: true });
  pdf.addImage(source, 'PNG', 0, 0, width, height, 'compatibility', 'NONE');
  const output = Buffer.from(pdf.output('arraybuffer')).toString('latin1'), objects = imageObjects(output);
  const imageId = Number(output.match(/\/I0 (\d+) 0 R/)?.[1]), image = objects.get(imageId)!;
  expect(image, names[type]).toBeDefined();
  expect(image.dictionary).toContain(`/Width ${width}`); expect(image.dictionary).toContain(`/Height ${height}`);
  expect(image.dictionary).toContain(`/BitsPerComponent ${depth}`); expect(image.dictionary).toContain(`/ColorSpace /${type === 0 || type === 4 ? 'DeviceGray' : 'DeviceRGB'}`);
  expect(image.dictionary).not.toContain('/Filter');
  const hasAlpha = type === 4 || type === 6, colorSamples = pixels.flatMap(pixel => hasAlpha ? pixel.slice(0, -1) : pixel);
  expect(image.data).toEqual(bytes(colorSamples, depth));
  if (hasAlpha) {
    const maskId = Number(image.dictionary.match(/\/SMask (\d+) 0 R/)?.[1]), mask = objects.get(maskId)!;
    expect(mask).toBeDefined(); expect(mask.dictionary).toContain('/ColorSpace /DeviceGray'); expect(mask.dictionary).toContain(`/BitsPerComponent ${depth}`);
    expect(mask.dictionary).toContain(`/Width ${width}`); expect(mask.dictionary).toContain(`/Height ${height}`);
    expect(mask.data).toEqual(bytes(pixels.map(pixel => pixel[channels[type] - 1]!), depth));
  } else expect(image.dictionary).not.toContain('/SMask');
});
