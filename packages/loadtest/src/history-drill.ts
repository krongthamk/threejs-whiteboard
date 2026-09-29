import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { BoardDocument, createElement } from '../../model/src/index.js';
import { Store } from '../../server/src/store.js';
import { createBackup, restoreBackup } from '../../server/src/operations.js';

const stem = fileURLToPath(new URL(`../results/history-${new Date().toISOString().replaceAll(':', '-')}`, import.meta.url));
const directory = `${stem}.storage`; mkdirSync(directory, { recursive: true });
const secret = randomBytes(48).toString('base64url'), store = new Store(join(directory, 'whiteboard.sqlite'), secret);
const owner = store.createUser('history-owner', randomBytes(24).toString('base64url')), board = store.createBoard(owner.id, '100000 historical updates');
const doc = new Y.Doc(); Y.applyUpdate(doc, store.loadDocument(board.id)!);
const model = new BoardDocument(doc, { undo: false });
model.transact(() => { for (let index = 0; index < 1280; index++) model.add(index % 4 ? createElement('stroke', { id: `history-${index}`, props: { points: [0, 0, 0.5, 80, 40, 0.5], simplified: true } }) : createElement('rect', { id: `history-${index}` })); });
store.compact(board.id, Y.encodeStateAsUpdate(doc));
let updates = 0, bytes = 0, compactions = 0;
doc.on('update', update => { updates++; bytes += update.byteLength; store.appendUpdate(board.id, update); if (store.needsCompaction(board.id)) { store.compact(board.id, Y.encodeStateAsUpdate(doc)); compactions++; } });
const startedAt = Date.now(), clock = performance.now(), cpu = process.cpuUsage();
const record = (event: object) => appendFileSync(`${stem}.ndjson`, `${JSON.stringify(event)}\n`);
record({ type: 'start', startedAt, updates: 100000, elements: 1280, mix: '60%48-point stroke replacements,20%movement,20%style', durability: 'SQLite WAL synchronousFULL, one committed update per gesture', hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version } });
try {
  for (let sequence = 1; sequence <= 100000; sequence++) {
    const kind = sequence % 5, slot = kind < 3 ? (sequence % 960) + Math.floor((sequence % 960) / 3) + 1 : (sequence % 320) * 4;
    const id = `history-${slot}`;
    if (kind < 3) { const points: number[] = []; for (let point = 0; point < 48; point++) points.push(point * 2 + sequence % 100, Math.sin((point + sequence) / 8) * 30, 0.3 + (point % 7) / 10); model.update(id, { props: { points, simplified: true } }); }
    else if (kind === 3) model.update(id, { x: sequence % 300, y: sequence % 200 });
    else model.updateStyle([id], { stroke: sequence % 2 ? '#4678ca' : '#b84354', strokeWidth: 2 + sequence % 3 });
    if (sequence % 10000 === 0) { const event = { type: 'progress', sequence, updates, elapsedMs: performance.now() - clock, bytes, compactions, storage: store.stats(board.id) }; record(event); console.log(JSON.stringify(event)); }
  }
  store.compact(board.id, Y.encodeStateAsUpdate(doc)); compactions++;
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const modelHash = (value: BoardDocument) => createHash('sha256').update(JSON.stringify(canonical(value.readAll().sort((a, b) => a.id.localeCompare(b.id))))).digest('hex');
  const expected = modelHash(model), loads: { milliseconds: number; hash: string; elements: number }[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = performance.now(), restoredDoc = new Y.Doc(); Y.applyUpdate(restoredDoc, store.loadDocument(board.id)!);
    const restored = new BoardDocument(restoredDoc, { undo: false }), elements = restored.readAll().length;
    const milliseconds = performance.now() - start, hash = modelHash(restored); loads.push({ milliseconds, hash, elements }); restored.destroy(); restoredDoc.destroy();
  }
  const assetDirectory = join(directory, 'assets'); mkdirSync(assetDirectory);
  const assetBytes = Buffer.from([137,80,78,71,13,10,26,10]); writeFileSync(join(assetDirectory, 'drill-image'), assetBytes); store.addAsset({ id: 'drill-image', boardId: board.id, mimeType: 'image/png', size: assetBytes.length, storageKey: 'drill-image' });
  await createBackup(store, assetDirectory, secret, `${stem}.backup`); restoreBackup(`${stem}.backup`, `${stem}.restored`);
  const recoveredStore = new Store(join(`${stem}.restored`, 'whiteboard.sqlite'), secret), recoveredDoc = new Y.Doc(); Y.applyUpdate(recoveredDoc, recoveredStore.loadDocument(board.id)!);
  const recovered = new BoardDocument(recoveredDoc, { undo: false }), restoredHash = modelHash(recovered), assetMatches = readFileSync(join(`${stem}.restored`, 'assets', 'drill-image')).equals(assetBytes);
  recovered.destroy(); recoveredDoc.destroy(); recoveredStore.close();
  const cpuUsed = process.cpuUsage(cpu), result = { startedAt, endedAt: Date.now(), elapsedMs: performance.now() - clock, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000, historicalUpdates: updates, updateBytes: bytes, compactions, currentElements: model.readAll().length, storage: store.stats(board.id), loads, expectedHash: expected, restoredHash, assetMatches,
    passed: updates === 100000 && loads.every(load => load.milliseconds < 2000 && load.hash === expected && load.elements === 1280) && restoredHash === expected && assetMatches,
    methodology: '100000 real schema2 gestures after1280-element initialization, one writer; exact60/20/20 mix. All updates committed with SQLite WAL FULL;5MiB/10000 compaction. Loads include SQLite snapshot read, Yjs apply, BoardDocument construction, and full1280-element projection; SHA validation timed separately. Three sequential OS-cache-warm loads; historical workload emulates update count, not six calendar months. No document clock/identity reset.' };
  writeFileSync(`${stem}.json`, JSON.stringify(result, null, 2)); record({ type: 'complete', ...result }); console.log(JSON.stringify({ stem, ...result })); if (!result.passed) process.exitCode = 1;
} finally { model.destroy(); doc.destroy(); store.close(); }
