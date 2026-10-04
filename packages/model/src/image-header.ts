export interface ImageHeader { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; orientation?: number }
export const MAX_IMAGE_DIMENSION = 16384;
export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function assertSafeImageDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid image dimensions');
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) throw new Error(`Images support up to ${MAX_IMAGE_DIMENSION} pixels per side`);
  if (width * height > MAX_IMAGE_PIXELS) throw new Error('Images must contain at most 100,000,000 pixels');
}
const invalid = (): never => { throw new Error('Invalid or incomplete PNG, JPEG, or WebP image header'); };
const text = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
function dimensions(mimeType: ImageHeader['mimeType'], width: number, height: number, orientation = 1): ImageHeader {
  if (width <= 0 || height <= 0) invalid();
  // Browser image decoders apply EXIF orientation; swaps preserve area and side limits.
  return { mimeType, width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height, ...(orientation !== 1 ? { orientation } : {}) };
}
function exifOrientation(bytes: Uint8Array): number {
  if (text(bytes, 0, 6) === 'Exif\0\0') bytes = bytes.subarray(6);
  if (bytes.length < 8) return invalid();
  const little = text(bytes, 0, 2) === 'II';
  if (!little && text(bytes, 0, 2) !== 'MM') return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return invalid();
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset > bytes.length - 2) return invalid();
  const count = view.getUint16(offset, little);
  if (count > Math.floor((bytes.length - offset - 2) / 12)) return invalid();
  for (let index = 0; index < count; index++) {
    const at = offset + 2 + index * 12;
    if (view.getUint16(at, little) !== 0x112) continue;
    if (view.getUint16(at + 2, little) !== 3 || view.getUint32(at + 4, little) !== 1) return invalid();
    const orientation = view.getUint16(at + 8, little);
    if (orientation < 1 || orientation > 8) return invalid();
    return orientation;
  }
  return 1;
}

/** Reads bounded container metadata without creating a bitmap or allocating pixel storage. */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || text(bytes, 12, 4) !== 'IHDR') return invalid();
    const width = view.getUint32(16), height = view.getUint32(20);
    // Reject contradictory later headers and APNG frames that could ask a decoder
    // for more pixels than the bounded canvas. CRC/payload validity is left to decoding.
    for (let offset = 33; offset < bytes.length;) {
      if (offset > bytes.length - 12) return invalid();
      const size = view.getUint32(offset), at = offset + 8, type = text(bytes, offset + 4, 4);
      if (size > bytes.length - offset - 12 || type === 'IHDR') return invalid();
      if (type === 'fcTL') {
        if (size !== 26) return invalid();
        const frameWidth = view.getUint32(at + 4), frameHeight = view.getUint32(at + 8);
        if (!frameWidth || !frameHeight || view.getUint32(at + 12) + frameWidth > width || view.getUint32(at + 16) + frameHeight > height) return invalid();
      }
      offset += size + 12;
      if (type === 'IEND' && (size !== 0 || offset !== bytes.length)) return invalid();
    }
    return dimensions('image/png', width, height);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, width = 0, height = 0, orientation = 1;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0) return invalid();
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset > bytes.length - 2) return invalid();
      const size = view.getUint16(offset);
      if (size < 2 || size > bytes.length - offset) return invalid();
      if (marker === 0xe1 && text(bytes, offset + 2, 6) === 'Exif\0\0') orientation = exifOrientation(bytes.subarray(offset + 2, offset + size));
      // SOFn except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (size < 8 || width || height) return invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      offset += size;
    }
    if (!width || !height) return invalid();
    return dimensions('image/jpeg', width, height, orientation);
  }
  // https://developers.google.com/speed/webp/docs/riff_container
  if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') {
    if (bytes.length < 20) return invalid();
    const end = view.getUint32(4, true) + 8;
    if (end > bytes.length || end < 20) return invalid();
    const uint24 = (position: number) => bytes[position]! + bytes[position + 1]! * 256 + bytes[position + 2]! * 65536;
    function bitstream(type: string, at: number, size: number): ImageHeader | undefined {
      if (type === 'VP8L') {
        if (size < 5 || bytes[at] !== 0x2f) return invalid();
        const packed = view.getUint32(at + 1, true);
        return dimensions('image/webp', (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      }
      if (type === 'VP8 ') {
        if (size < 10 || text(bytes, at + 3, 3) !== '\x9d\x01\x2a') return invalid();
        return dimensions('image/webp', view.getUint16(at + 6, true) & 0x3fff, view.getUint16(at + 8, true) & 0x3fff);
      }
    }
    function chunk(offset: number, boundary: number) {
      if (offset > boundary - 8) return invalid();
      const type = text(bytes, offset, 4), size = view.getUint32(offset + 4, true), at = offset + 8;
      if (size > boundary - at || size + (size % 2) > boundary - at) return invalid();
      return { type, size, at, next: at + size + (size % 2) };
    }
    let width = 0, height = 0, orientation = 1, extended = false, animated = false, imageSeen = false;
    for (let offset = 12; offset < end;) {
      const { type, size, at, next } = chunk(offset, end);
      if (type === 'VP8X') {
        if (size !== 10 || offset !== 12) return invalid();
        width = uint24(at + 4) + 1; height = uint24(at + 7) + 1;
        extended = true; animated = !!(bytes[at]! & 2);
      } else if (type === 'ANMF') {
        if (!extended || !animated || size < 16) return invalid();
        const frameWidth = uint24(at + 6) + 1, frameHeight = uint24(at + 9) + 1;
        if (uint24(at) * 2 + frameWidth > width || uint24(at + 3) * 2 + frameHeight > height) return invalid();
        let frameImageSeen = false;
        for (let frameOffset = at + 16; frameOffset < at + size;) {
          const frame = chunk(frameOffset, at + size), image = bitstream(frame.type, frame.at, frame.size);
          if (image) {
            if (frameImageSeen || image.width !== frameWidth || image.height !== frameHeight) return invalid();
            frameImageSeen = true;
          } else if (frame.type !== 'ALPH') return invalid();
          frameOffset = frame.next;
        }
        if (!frameImageSeen) return invalid();
      } else if (type === 'EXIF') orientation = exifOrientation(bytes.subarray(at, at + size));
      else {
        const image = bitstream(type, at, size);
        if (image) {
          if (imageSeen || animated || extended && (image.width !== width || image.height !== height)) return invalid();
          imageSeen = true;
          if (!extended) { width = image.width; height = image.height; }
        }
      }
      offset = next;
    }
    if (!width || !height) return invalid();
    return dimensions('image/webp', width, height, orientation);
  }
  return invalid();
}
