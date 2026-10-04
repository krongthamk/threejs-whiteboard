/** Structural headers for predecode validation tests; these are not complete compressed images. */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
export function jpegHeader(width: number, height: number, orientation?: number): Uint8Array {
  const app: number[] = [];
  if (orientation !== undefined) {
    const tiff = new Uint8Array(26), view = new DataView(tiff.buffer);
    tiff.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 1, true);
    view.setUint16(10, 0x112, true); view.setUint16(12, 3, true); view.setUint32(14, 1, true); view.setUint16(18, orientation, true);
    const payload = [69, 120, 105, 102, 0, 0, ...tiff]; app.push(255, 225, 0, payload.length + 2, ...payload);
  }
  return Uint8Array.from([255, 216, ...app, 255, 192, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 17, 0, 255, 217]);
}
export function webpHeader(width: number, height: number, type: 'VP8 ' | 'VP8L' | 'VP8X'): Uint8Array {
  const payload = new Uint8Array(type === 'VP8L' ? 5 : 10), value = new DataView(payload.buffer);
  if (type === 'VP8L') { payload[0] = 0x2f; value.setUint32(1, (width - 1) | ((height - 1) << 14), true); }
  else if (type === 'VP8 ') { payload.set([0x9d, 1, 0x2a], 3); value.setUint16(6, width, true); value.setUint16(8, height, true); }
  else for (let n = 0; n < 3; n++) { payload[4 + n] = (width - 1) >>> (n * 8) & 255; payload[7 + n] = (height - 1) >>> (n * 8) & 255; }
  const bytes = new Uint8Array(20 + payload.length + (payload.length % 2)), view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70]); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 69, 66, 80], 8);
  bytes.set([...type].map(character => character.charCodeAt(0)), 12); view.setUint32(16, payload.length, true); bytes.set(payload, 20);
  return bytes;
}
