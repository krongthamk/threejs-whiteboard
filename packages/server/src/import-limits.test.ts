import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { MAX_IMAGE_BYTES } from '@whiteboard/model';
import { createWhiteboardServer } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// A complete 1x1 RGBA PNG, padded with a valid ancillary tEXt chunk. This tests
// the HTTP raw-byte contract without allocating a 20 MiB bitmap or using a decoder.
const crcTable = Uint32Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.allocUnsafe(data.length + 12);
  bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ crc >>> 8;
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(byteLength?: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 70, 130, 180, 255]))), chunk('IEND', Buffer.alloc(0))];
  if (byteLength !== undefined) {
    const text = Buffer.alloc(byteLength - parts.reduce((size, part) => size + part.length, 0) - 12, 97);
    text.write('Boundary\0', 0, 'latin1'); parts.splice(2, 0, chunk('tEXt', text));
  }
  return Buffer.concat(parts);
}
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-import-limits-')), assetDirectory = join(directory, 'assets');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = createWhiteboardServer({ databasePath: join(directory, 'board.sqlite'), assetDirectory,
    sessionSecret: 'import-limits-test-secret-with-at-least-thirty-two-characters', port: 0 });
  cleanups.push(() => app.close()); await app.listen();
  const owner = app.store.createUser('owner', 'import-limits-test-only-password'), editor = app.store.createUser('editor', 'import-limits-test-only-password');
  const board = app.store.createBoard(owner.id, 'Raw upload boundary'); app.store.setMember(board.id, editor.id, 'editor');
  const token = (await app.store.login(editor.username, 'import-limits-test-only-password'))!.token;
  const origin = `http://127.0.0.1:${app.port}`, path = `/api/boards/${board.id}/assets`;
  const upload = (bytes: Buffer) => fetch(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: Uint8Array.from(bytes) });
  const rows = () => app.store.db.prepare('SELECT * FROM assets ORDER BY id').all();
  const blobs = () => readdirSync(assetDirectory).sort().map(name => ({ name, sha256: createHash('sha256').update(readFileSync(join(assetDirectory, name))).digest('hex') }));
  return { app, board, origin, upload, rows, blobs, assetDirectory };
}

test('an authenticated editor upload above 20 MiB returns 413 without changing assets and permits a healthy follow-up', async () => {
  const { app, board, origin, upload, rows, blobs } = await setup();
  const seed = await upload(png()); expect(seed.status).toBe(201); await seed.json();
  const before = { rows: rows(), blobs: blobs(), document: app.store.loadDocument(board.id), stats: app.store.stats(board.id) };
  const oversized = png(MAX_IMAGE_BYTES + 1); expect(oversized.length).toBe(MAX_IMAGE_BYTES + 1);
  const refused = await upload(oversized); expect(refused.status).toBe(413); expect(await refused.json()).toEqual({ error: 'Upload is too large' });
  expect(rows()).toEqual(before.rows); expect(blobs()).toEqual(before.blobs);
  expect(app.store.loadDocument(board.id)).toEqual(before.document); expect(app.store.stats(board.id)).toEqual(before.stats);
  const healthy = await upload(png()); expect(healthy.status).toBe(201); expect(await healthy.json()).toMatchObject({ width: 1, height: 1, mimeType: 'image/png' });
  expect(rows()).toHaveLength(before.rows.length + 1); expect(blobs()).toHaveLength(before.blobs.length + 1);
  expect((await fetch(origin + '/ready')).status).toBe(200);
});

test('an authenticated editor upload at exactly 20 MiB stores all original PNG bytes', async () => {
  const { app, board, upload, rows, blobs, assetDirectory } = await setup();
  const bytes = png(MAX_IMAGE_BYTES); expect(bytes.length).toBe(MAX_IMAGE_BYTES);
  const response = await upload(bytes); expect(response.status).toBe(201);
  const metadata = await response.json(); expect(metadata).toMatchObject({ width: 1, height: 1, mimeType: 'image/png' });
  const asset = app.store.asset(board.id, metadata.assetId)!;
  expect(asset.size).toBe(MAX_IMAGE_BYTES); expect(rows()).toHaveLength(1); expect(blobs()).toHaveLength(1);
  expect(readFileSync(join(assetDirectory, asset.storageKey)).equals(bytes)).toBe(true);
});
