import { deflateSync } from 'node:zlib';

type ColorType = 0 | 2 | 4 | 6;
const width = 2, height = 2;

// Construct PNG chunks independently of fast-png: filter 0, zlib and PNG CRC32.
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function bytes(samples: readonly number[], depth: 8 | 16): Buffer {
  if (depth === 8) return Buffer.from(samples);
  const output = Buffer.alloc(samples.length * 2); samples.forEach((sample, index) => output.writeUInt16BE(sample, index * 2)); return output;
}
export function png(type: ColorType, depth: 8 | 16, pixels: readonly number[][], interlaced = false): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = type; header[12] = interlaced ? 1 : 0;
  const passes = interlaced ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows: Buffer[] = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    if (startX! >= width || startY! >= height) continue;
    for (let y = startY!; y < height; y += stepY!) {
      const samples: number[] = [];
      for (let x = startX!; x < width; x += stepX!) samples.push(...pixels[y * width + x]!);
      rows.push(Buffer.concat([Buffer.from([0]), bytes(samples, depth)]));
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
export function fixture(type: ColorType, depth: 8 | 16): number[][] {
  const gray = depth === 8 ? [32, 96, 160, 224] : [0x1234, 0x5678, 0x9abc, 0xdef0];
  const alpha = depth === 8 ? [0, 85, 170, 255] : [0, 0x3456, 0xabcd, 65535];
  const rgb = depth === 8 ? [[255, 17, 32], [64, 255, 96], [128, 160, 255], [224, 192, 176]] : [[0x1234, 0x5678, 0x9abc], [0x2468, 0xace0, 0x1357], [0x3210, 0x7654, 0xba98], [0xfedc, 0x5432, 0x9876]];
  return gray.map((sample, index) => type === 0 ? [sample] : type === 2 ? rgb[index]! : type === 4 ? [sample, alpha[index]!] : [...rgb[index]!, alpha[index]!]);
}
