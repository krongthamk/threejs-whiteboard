import * as Y from 'yjs';
import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CLOCK_KEY, WriterBoardDocument, WRITER_PREFIX, type WriterOptions } from './writer-model.js';

const NETWORK = Symbol('network');
function pair(options: WriterOptions = {}): [WriterBoardDocument, WriterBoardDocument] {
  const seed = new WriterBoardDocument(); seed.create('rect', { id: 's' });
  const result = [1, 2].map(clientID => { const doc = new Y.Doc(); doc.clientID = clientID; Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed.doc), NETWORK); return new WriterBoardDocument(doc, options); });
  seed.destroy(); return result as [WriterBoardDocument, WriterBoardDocument];
}
function sync(clients: WriterBoardDocument[]): void {
  for (let round = 0; round < 3; round++) {
    const snapshots = clients.map(client => Y.encodeStateAsUpdate(client.doc));
    for (const destination of clients) for (const snapshot of snapshots) Y.applyUpdate(destination.doc, snapshot, NETWORK);
  }
  for (const client of clients) expect(client.readAll()).toEqual(clients[0]!.readAll());
}

it('same-transaction clock deleteFilter keeps one gesture undoable without decrementing clock', () => {
  const [a, b] = pair(); let updates = 0;
  a.doc.on('update', () => updates++);
  a.move(['s'], { x: 75, y: 20 });
  const clock = a.own.kv.get(CLOCK_KEY)!.stamp.clock;
  expect(updates).toBe(1); expect(a.undoManager.undoStack).toHaveLength(1);
  a.undoManager.undo();
  expect(a.read('s')).toMatchObject({ x: 0, y: 0 });
  expect(a.own.kv.get(CLOCK_KEY)!.stamp.clock).toBe(clock);
  a.destroy(); b.destroy();
});

it.each(['same-transaction', 'separate-untracked'] as const)('%s: retains peer edits in concurrent winner undo and local deletion undo', clockMode => {
  const [a, b] = pair({ clockMode });
  a.updateStyle(['s'], { fill: '#ff0000' }); b.updateStyle(['s'], { fill: '#0000ff' }); sync([a, b]);
  const winner = a.read('s')!.style.fill === '#ff0000' ? a : b;
  const expected = winner === a ? '#0000ff' : '#ff0000';
  winner.undoManager.undo(); sync([a, b]); expect(a.read('s')!.style.fill).toBe(expected);
  a.undoManager.clear(); b.undoManager.clear();
  a.delete('s'); b.move(['s'], { x: 80, y: 25 }); sync([a, b]); expect(a.readAll()).toEqual([]);
  a.undoManager.undo(); sync([a, b]); expect(a.read('s')).toMatchObject({ x: 80, y: 25 });
  a.destroy(); b.destroy();
});

it.each(['same-transaction', 'separate-untracked'] as const)('%s clock survives undo and a fresh writer reload', clockMode => {
  const [a, b] = pair({ clockMode });
  a.move(['s'], { x: 75, y: 20 }); const oldClock = a.own.kv.get(CLOCK_KEY)!.stamp.clock;
  a.undoManager.undo(); sync([a, b]);
  const doc = new Y.Doc(); doc.clientID = 3; Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc), NETWORK);
  const c = new WriterBoardDocument(doc, { clockMode });
  c.update('s', { x: 120 }); sync([a, b, c]);
  expect(c.own.kv.get(CLOCK_KEY)!.stamp.clock).toBeGreaterThan(oldClock);
  a.undoManager.redo(); sync([a, b, c]); expect(a.read('s')!.x).toBe(120);
  // Empty writer arrays are local handles only and have no encoded CRDT contents.
  expect([...c.doc.share.keys()].filter(name => name.startsWith(WRITER_PREFIX))).toHaveLength(3);
  a.destroy(); b.destroy(); c.destroy();
});

it('keeps a causally newer peer value and merges independent move/recolor through local undo', () => {
  const [a, b] = pair();
  a.move(['s'], { x: 25, y: 35 }); b.updateStyle(['s'], { fill: '#ff0000' }); sync([a, b]);
  expect(a.read('s')).toMatchObject({ x: 25, y: 35, style: { fill: '#ff0000' } });
  a.undoManager.undo(); sync([a, b]); expect(a.read('s')).toMatchObject({ x: 0, y: 0, style: { fill: '#ff0000' } });
  a.updateStyle(['s'], { fill: '#00ff00' }); sync([a, b]);
  b.updateStyle(['s'], { fill: '#0000ff' }); sync([a, b]);
  a.undoManager.undo(); sync([a, b]); expect(a.read('s')!.style.fill).toBe('#0000ff');
  a.destroy(); b.destroy();
});

it('uses deterministic clock ties without combining concurrently created element generations', () => {
  const seed = new WriterBoardDocument();
  const aDoc = new Y.Doc(), bDoc = new Y.Doc(); aDoc.clientID = 1; bDoc.clientID = 2;
  const a = new WriterBoardDocument(aDoc), b = new WriterBoardDocument(bDoc); seed.destroy();
  a.transact(() => { a.create('text', { id: 'same', props: { text: 'Text', align: 'left', autoSize: true } }); a.update('same', { props: { text: 'Updated', align: 'right', autoSize: true } }); });
  b.transact(() => { b.create('stroke', { id: 'same', props: { points: [0, 0, .5, 10, 10, .8], simplified: false } }); b.move(['same'], { x: 25, y: 30 }); });
  sync([a, b]);
  expect(a.read('same')).toMatchObject({ type: 'stroke', x: 25, y: 30, props: { points: [25, 30, .5, 35, 40, .8] } });
  b.undoManager.undo(); sync([a, b]); expect(a.read('same')).toMatchObject({ type: 'text', props: { text: 'Updated', align: 'right' } });
  b.undoManager.redo(); sync([a, b]); expect(a.read('same')?.type).toBe('stroke');
  a.destroy(); b.destroy();
});

it('keeps an offline old writer safe across deletion, recreation and a fresh-client reload', () => {
  const [online, offline] = pair();
  offline.update('s', { x: 999 });
  online.delete('s');
  online.create('text', { id: 's', props: { text: 'New generation', align: 'left', autoSize: true } });
  online.update('s', { x: 50 });
  const doc = new Y.Doc(); doc.clientID = 3; Y.applyUpdate(doc, Y.encodeStateAsUpdate(online.doc), NETWORK);
  const fresh = new WriterBoardDocument(doc);
  sync([online, offline, fresh]);
  expect(fresh.read('s')).toMatchObject({ type: 'text', x: 50, props: { text: 'New generation' } });
  offline.undoManager.undo(); sync([online, offline, fresh]);
  expect(fresh.read('s')).toMatchObject({ type: 'text', x: 50 });
  offline.undoManager.redo(); sync([online, offline, fresh]);
  expect(fresh.read('s')).toMatchObject({ type: 'text', x: 50 });
  fresh.updateStyle(['s'], { fill: '#abcdef' }); sync([online, offline, fresh]);
  expect(online.read('s')!.style.fill).toBe('#abcdef');
  online.destroy(); offline.destroy(); fresh.destroy();
});

it('measures retained generation and writer records honestly under repeated lifecycle churn', () => {
  const board = new WriterBoardDocument();
  const samples: { cycles: number; visibleElements: number; liveRecords: number; structs: number; snapshotBytes: number }[] = [];
  for (let cycle = 1; cycle <= 200; cycle++) {
    board.create(cycle % 2 ? 'rect' : 'ellipse', { id: 'reused' });
    board.update('reused', { x: cycle, y: cycle * 2 });
    board.delete('reused');
    board.undoManager.undo(); expect(board.read('reused')).toMatchObject({ x: cycle, y: cycle * 2 });
    board.undoManager.redo(); expect(board.readAll()).toEqual([]);
    board.undoManager.clear();
    if (cycle % 50 === 0) samples.push({ cycles: cycle, visibleElements: board.readAll().length, liveRecords: [...board.writers.values()].reduce((sum, writer) => sum + writer.records.length, 0), structs: [...board.doc.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0), snapshotBytes: Y.encodeStateAsUpdate(board.doc).byteLength });
  }
  expect(samples.at(-1)!.liveRecords).toBe(402);
  expect(samples.every(sample => sample.visibleElements === 0)).toBe(true);
  expect(samples[3]!.snapshotBytes).toBeGreaterThan(samples[0]!.snapshotBytes);
  mkdirSync('spikes/model-kv/reports', { recursive: true });
  writeFileSync('spikes/model-kv/reports/lifecycle-retention.json', `${JSON.stringify({ interpretation: 'Hot edits plateau for fixed writer/key/generation sets. Retired writer arrays and obsolete generation overrides are retained to preserve offline merge and undo; lifecycle churn is not bounded by visible element count.', samples }, null, 2)}\n`);
  board.destroy();
});

it('fails closed after Yjs changes the writer client ID, including undo and redo', () => {
  const original = new Y.Doc(); original.clientID = 44;
  const stale = new WriterBoardDocument(original);
  stale.create('rect', { id: 'existing' });
  const collision = new Y.Doc(); Y.applyUpdate(collision, Y.encodeStateAsUpdate(stale.doc), NETWORK); collision.clientID = 44;
  const other = new WriterBoardDocument(collision); other.create('ellipse', { id: 'peer' });
  Y.applyUpdate(stale.doc, Y.encodeStateAsUpdate(other.doc), NETWORK);
  expect(stale.doc.clientID).not.toBe(44);
  const before = Y.encodeStateAsUpdate(stale.doc);
  expect(() => stale.update('existing', { x: 99 })).toThrow('client-ID collision');
  expect(() => stale.undoManager.undo()).toThrow('client-ID collision');
  expect(() => stale.undoManager.redo()).toThrow('client-ID collision');
  expect(Y.encodeStateAsUpdate(stale.doc)).toEqual(before);
  stale.destroy(); other.destroy();
});
