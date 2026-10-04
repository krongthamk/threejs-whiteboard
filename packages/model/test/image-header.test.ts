import { expect, test } from 'vitest';
import { assertSafeImageDimensions, readImageHeader } from '../src/index';
import { jpegHeader, pngHeader, webpHeader } from '../../../tests/image-fixtures';

test('reads PNG IHDR dimensions from a bounded subarray without decoding pixels', () => {
  const image = pngHeader(30000, 30000), padded = new Uint8Array(image.length + 17); padded.set(image, 9);
  expect(readImageHeader(padded.subarray(9, 9 + image.length))).toEqual({ mimeType: 'image/png', width: 30000, height: 30000 });
  expect(() => assertSafeImageDimensions(30000, 30000)).toThrow();
});
test.each([undefined, 1, 2, 3, 4, 5, 6, 7, 8])('reads JPEG SOF and EXIF display orientation %s without allocating decoded pixels', orientation => {
  expect(readImageHeader(jpegHeader(120, 80, orientation))).toEqual({ mimeType: 'image/jpeg', width: orientation && orientation >= 5 ? 80 : 120, height: orientation && orientation >= 5 ? 120 : 80, ...(orientation && orientation !== 1 ? { orientation } : {}) });
});
test.each(['VP8 ', 'VP8L', 'VP8X'] as const)('reads %s WebP canvas dimensions', type => {
  expect(readImageHeader(webpHeader(321, 123, type))).toEqual({ mimeType: 'image/webp', width: 321, height: 123 });
});
test('rejects incomplete PNG, JPEG marker spans, malformed EXIF offsets and truncated WebP chunks', () => {
  expect(() => readImageHeader(pngHeader(1, 1).subarray(0, 23))).toThrow();
  expect(() => readImageHeader(Uint8Array.from([255, 216, 255, 225, 255, 255]))).toThrow();
  const jpeg = jpegHeader(120, 80, 6); new DataView(jpeg.buffer).setUint32(16, 0xffffffff, true);
  expect(() => readImageHeader(jpeg)).toThrow();
  const webp = webpHeader(3, 4, 'VP8X'); new DataView(webp.buffer).setUint32(16, 0xffffffff, true);
  expect(() => readImageHeader(webp)).toThrow();
  expect(() => readImageHeader(new Uint8Array(33))).toThrow();
});
test('enforces positive integer dimensions, the 16384 side limit and the 100million pixel limit', () => {
  expect(() => assertSafeImageDimensions(16384, 6103)).not.toThrow();
  for (const [width, height] of [[16385, 1], [10001, 10000], [0, 1], [1, -1], [1.5, 2], [Infinity, 1]]) expect(() => assertSafeImageDimensions(width, height)).toThrow();
});

function extendedWebp(canvasWidth: number, canvasHeight: number, streamWidth: number, streamHeight: number, animated = false): Uint8Array {
  const canvas = webpHeader(canvasWidth, canvasHeight, 'VP8X');
  if (animated) canvas[20] = 2;
  let extra = webpHeader(streamWidth, streamHeight, 'VP8L').subarray(12);
  if (animated) {
    const frame = new Uint8Array(8 + 16 + extra.length), view = new DataView(frame.buffer);
    frame.set([65, 78, 77, 70]); view.setUint32(4, frame.length - 8, true);
    for (let n = 0; n < 3; n++) { frame[14 + n] = (streamWidth - 1) >>> (n * 8) & 255; frame[17 + n] = (streamHeight - 1) >>> (n * 8) & 255; }
    frame.set(extra, 24); extra = frame;
  }
  const result = new Uint8Array(canvas.length + extra.length); result.set(canvas); result.set(extra, canvas.length);
  new DataView(result.buffer).setUint32(4, result.length - 8, true); return result;
}
test('VP8X cannot conceal a larger lossless image behind a small declared canvas', () => {
  expect(() => readImageHeader(extendedWebp(1, 1, 16384, 16384))).toThrow();
  expect(readImageHeader(extendedWebp(10, 10, 10, 10))).toMatchObject({ width: 10, height: 10 });
});
test('animated WebP frame bounds and nested stream dimensions must agree before decode', () => {
  expect(() => readImageHeader(extendedWebp(1, 1, 16384, 16384, true))).toThrow();
  const valid = extendedWebp(10, 10, 5, 5, true);
  expect(readImageHeader(valid)).toMatchObject({ width: 10, height: 10 });
  // ANMF frame metadata says 5x5 while its nested VP8L header says 10000x10001.
  const inconsistent = valid.slice(); new DataView(inconsistent.buffer).setUint32(63, 9999 | (10000 << 14), true);
  expect(() => readImageHeader(inconsistent)).toThrow();
});

test('contradictory JPEG SOF markers cannot replace a large frame with a small last frame', () => {
  const first = jpegHeader(30000, 30000).subarray(0, -2), second = jpegHeader(1, 1).subarray(2);
  const bytes = new Uint8Array(first.length + second.length); bytes.set(first); bytes.set(second, first.length);
  expect(() => readImageHeader(bytes)).toThrow();
});
test('PNG duplicate IHDR and APNG frames outside the declared canvas are rejected', () => {
  const first = pngHeader(1, 1), second = pngHeader(30000, 30000).subarray(8);
  const duplicate = new Uint8Array(first.length + second.length); duplicate.set(first); duplicate.set(second, first.length);
  expect(() => readImageHeader(duplicate)).toThrow();
  const frame = new Uint8Array(38), view = new DataView(frame.buffer);
  view.setUint32(0, 26); frame.set([102, 99, 84, 76], 4); view.setUint32(12, 30000); view.setUint32(16, 30000);
  const animated = new Uint8Array(first.length + frame.length); animated.set(first); animated.set(frame, first.length);
  expect(() => readImageHeader(animated)).toThrow();
});
