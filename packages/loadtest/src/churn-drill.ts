import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { BoardDocument, assertValidElement } from '../../model/src/index.js';
import { CLOCK_KEY, WRITER_PREFIX, type WriterRecord, type StampedValue } from '../../model/src/document.js';
import { Store } from '../../server/src/store.js';
import { createBackup, restoreBackup } from '../../server/src/operations.js';

const days = Number(process.env.CHURN_DAYS ?? 180), sessionsPerDay = 2, gesturesPerSession = 300;
assert(Number.isInteger(days) && days > 0 && days <= 180);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const stem = fileURLToPath(new URL(`../results/churn-${new Date().toISOString().replaceAll(':', '-')}`, import.meta.url));
const directory = `${stem}.storage`; mkdirSync(directory, { recursive: true });
const inputs = ['packages/loadtest/src/churn-drill.ts', 'packages/server/src/store.ts', 'packages/server/src/operations.ts', 'pnpm-lock.yaml', ...readdirSync(join(root, 'packages/model/src')).filter(name => /\.(ts|json)$/.test(name)).map(name => `packages/model/src/${name}`)];
writeFileSync(`${stem}.sources.json`, JSON.stringify(Object.fromEntries(inputs.map(file => { const source = readFileSync(join(root, file), 'utf8'); return [file, { sha256: createHash('sha256').update(source).digest('hex'), source }]; })), null, 2));
const secret = randomBytes(48).toString('base64url'), store = new Store(join(directory, 'whiteboard.sqlite'), secret);
const owner = store.createUser('churn-owner', randomBytes(24).toString('base64url')), board = store.createBoard(owner.id, '180 simulated busy-board days');
const seedDoc = new Y.Doc(); Y.applyUpdate(seedDoc, store.loadDocument(board.id)!);
const seed = new BoardDocument(seedDoc, { undo: false, initializeMetadata: false });
seed.transact(() => {
  for (let index = 0; index < 100; index++) {
    if (index < 80) seed.create('rect', { id: `stable-${index}`, x: index * 10 });
    else seed.create('stroke', { id: `stable-${index}`, props: { points: [0, 0, 0.5, 20, 10, 0.5], simplified: true } });
  }
  for (let index = 0; index < 5; index++) seed.create('rect', { id: `cycle-${index}` });
  seed.create('rect', { id: 'offline-probe', x: 0, y: 0 });
});
const seedActor = seed.actor; store.compact(board.id, Y.encodeStateAsUpdate(seedDoc)); seed.destroy();
let serverDoc = new Y.Doc(); Y.applyUpdate(serverDoc, store.loadDocument(board.id)!);
const offlineDoc = new Y.Doc(); Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(serverDoc));
const offline = new BoardDocument(offlineDoc, { undo: false, initializeMetadata: false }), oldGeneration = offline.base('cycle-0')!.generation;
const offlineUpdates: Uint8Array[] = []; offlineDoc.on('update', update => offlineUpdates.push(update));
offline.move(['offline-probe'], { x: 75, y: 25 });
offline.move(['cycle-0'], { x: 999, y: 999 });
let actualUpdates = 0, updateBytes = 0, compactions = 0, gestures = 0, maxObservedClock = 0;
const sessionActors: string[] = [], checkpoints: object[] = [];
const startedAt = Date.now(), clock = performance.now(), cpu = process.cpuUsage();
const record = (event: object) => appendFileSync(`${stem}.ndjson`, `${JSON.stringify(event)}\n`);
const persist = (update: Uint8Array) => { actualUpdates++; updateBytes += update.byteLength; store.appendUpdate(board.id, update); if (store.needsCompaction(board.id)) { store.compact(board.id, Y.encodeStateAsUpdate(serverDoc)); compactions++; } };
serverDoc.on('update', persist);
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const projection = (model: BoardDocument) => model.readAll().sort((a, b) => a.id.localeCompare(b.id));
const raw = (doc: Y.Doc) => [...doc.share.keys()].filter(name => name.startsWith(WRITER_PREFIX)).sort().map(name => [name, doc.getArray<WriterRecord>(name).toArray()]).filter(([, values]) => (values as WriterRecord[]).length > 0);
function inspect(doc: Y.Doc) {
  const all: WriterRecord[] = [], actors: string[] = [];
  for (const name of doc.share.keys()) if (name.startsWith(WRITER_PREFIX)) { const records = doc.getArray<WriterRecord>(name).toArray(); if (records.length) { actors.push(name.slice(WRITER_PREFIX.length)); all.push(...records); } }
  // Match the model's lexical tiebreak exactly (not locale/numeric collation).
  const wins = (a: StampedValue, b: StampedValue) => a.stamp.clock > b.stamp.clock || a.stamp.clock === b.stamp.clock && a.stamp.actor > b.stamp.actor;
  const winners = new Map<string, StampedValue>();
  for (const { key, val } of all) if (!winners.has(key) || wins(val, winners.get(key)!)) winners.set(key, val);
  const active = new Map<string, string>();
  for (const [key, value] of winners) { const parts = JSON.parse(key); if (parts[1] === '$base' && value.value) active.set(parts[0], (value.value as { generation: string }).generation); }
  let clocks = 0, visibleRegisters = 0, staleGenerationRecords = 0;
  for (const { key, val } of all) { const parts = JSON.parse(key); if (key === CLOCK_KEY) clocks++; else {
    const currentGeneration = active.get(parts[0]);
    if (parts.length === 3 && parts[1] !== currentGeneration) staleGenerationRecords++;
    if (winners.get(key) === val && (parts[1] === '$base' && !!val.value || parts.length === 3 && parts[1] === currentGeneration)) visibleRegisters++;
  } }
  let retainedStructs = 0, deletedStructs = 0;
  for (const structs of doc.store.clients.values()) for (const item of structs) { retainedStructs++; if (item.deleted) deletedStructs++; }
  return { nonemptyWriterArrays: actors.length, retiredWriterArrays: actors.filter(actor => actor !== offline.actor).length, records: all.length, clockRecords: clocks, visibleRegisters, otherRetainedRecords: all.length - clocks - visibleRegisters, staleGenerationRecords, visibleElements: active.size, retainedStructs, deletedStructs, snapshotBytes: Y.encodeStateAsUpdate(doc).byteLength };
}
const assumptions = { simulatedDays: days, sessionsPerDay, gesturesPerSession, expectedGestures: days * sessionsPerDay * gesturesPerSession, stableElements: 100, reusedLifecycleIds: 5, offlineProbeElements: 1, initialVisibleElements: 106,
  turnover: 'Two newly generated actual Y.Doc writer IDs each simulated day. Retired writer arrays and all generations are retained; no reset, epoch cutoff, writer garbage collection, or undo history.',
  lifecycle: 'Writer 1 deletes and recreates each of five reused IDs every day (alternating rect/ellipse by day), writer 2 moves all five. 900 delete/recreate pairs at 180 days.',
  remainingMix: 'Each session recolors offline-probe once. Stable inventory is 80 shapes/20 strokes: modular scheduling touches 12 stroke IDs and 32 shape IDs (16 moved, 16 restyled), with 56 cold stable IDs retained. Stroke replacements have 12 points. This is a churn drill, separate from S3 payload mix.',
  offline: 'One day-0 replica makes an independent probe move and stale-generation cycle-0 move. Neither is transmitted until after day-180 final compaction and reload. Online sessions modify probe style, preserving offline x/y independently.',
  calendar: '180 logical daily workloads are accelerated; no wall-clock timestamps are backdated and no claim of six months elapsed time.', durability: 'Actual Store SQLite WAL synchronous FULL; update commits and 5MiB/10000-update compaction, then snapshot reload and verified backup restore.' };
record({ type: 'start', startedAt, assumptions, hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version }, seedActor, offlineActor: offline.actor });
try {
  for (let day = 0; day < days; day++) {
    for (let session = 0; session < sessionsPerDay; session++) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(serverDoc));
      doc.on('update', update => Y.applyUpdate(serverDoc, update, 'session-relay'));
      const model = new BoardDocument(doc, { undo: false, initializeMetadata: false });
      assert(!sessionActors.includes(model.actor) && model.actor !== seedActor && model.actor !== offline.actor, 'Writer IDs must be unique'); sessionActors.push(model.actor);
      let previousClock = 0;
      for (let operation = 0; operation < gesturesPerSession; operation++) {
        const sequence = gestures + 1;
        if (session === 0 && operation < 10) { const id = `cycle-${Math.floor(operation / 2)}`; if (operation % 2 === 0) model.delete([id]); else model.create(day % 2 ? 'ellipse' : 'rect', { id, x: day, y: day }); }
        else if (session === 1 && operation < 5) model.move([`cycle-${operation}`], { x: 1, y: 2 });
        else if (operation === (session === 0 ? 10 : 5)) model.updateStyle(['offline-probe'], { fill: `#${(sequence % 0xffffff).toString(16).padStart(6, '0')}` });
        else if (operation % 5 < 3) {
          const points: number[] = []; for (let point = 0; point < 12; point++) points.push(point * 3 + sequence % 100, Math.sin((point + sequence) / 8) * 15, 0.5);
          model.update(`stable-${80 + operation % 20}`, { props: { points, simplified: true } });
        } else if (operation % 5 === 3) model.update(`stable-${operation % 80}`, { x: sequence % 300, y: sequence % 200 });
        else model.updateStyle([`stable-${operation % 80}`], { fill: `#${(sequence % 0xffffff).toString(16).padStart(6, '0')}` });
        const ownClock = model.own.kv.get(CLOCK_KEY)!.stamp.clock;
        assert(ownClock > previousClock && ownClock > maxObservedClock, 'Lamport ledger must increase above prior writers'); previousClock = ownClock; maxObservedClock = ownClock; gestures++;
      }
      assert.equal(hash(raw(doc)), hash(raw(serverDoc)), 'Session raw writer arrays must match relay');
      for (const element of model.readAll()) assertValidElement(element);
      assert.equal(model.readAll().length, 106); model.destroy();
    }
    if ((day + 1) % 30 === 0 || day + 1 === days) {
      const checkpoint = { type: 'progress', day: day + 1, gestures, actualUpdates, elapsedMs: performance.now() - clock, compactions, updateBytes, ...inspect(serverDoc), storage: store.stats(board.id) };
      checkpoints.push(checkpoint); record(checkpoint); console.log(JSON.stringify(checkpoint));
    }
  }
  const historyUpdates = actualUpdates;
  store.compact(board.id, Y.encodeStateAsUpdate(serverDoc)); compactions++;
  const beforeReconnectRaw = hash(raw(serverDoc)), beforeReconnectStats = inspect(serverDoc), loads: { milliseconds: number; rawHash: string; projectionHash: string; elements: number }[] = [];
  let expectedProjection = '', latestCycle: unknown, latestProbeFill: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = performance.now(), doc = new Y.Doc(); Y.applyUpdate(doc, store.loadDocument(board.id)!);
    const model = new BoardDocument(doc, { undo: false, initializeMetadata: false }), elements = projection(model), milliseconds = performance.now() - start;
    for (const element of elements) assertValidElement(element);
    const projectionHash = hash(elements), rawHash = hash(raw(doc));
    if (attempt === 0) { expectedProjection = projectionHash; latestCycle = model.read('cycle-0'); latestProbeFill = model.read('offline-probe')!.style.fill; assert.notEqual(model.base('cycle-0')!.generation, oldGeneration); }
    assert.equal(rawHash, beforeReconnectRaw); assert.equal(projectionHash, expectedProjection); assert.equal(elements.length, 106);
    loads.push({ milliseconds, rawHash, projectionHash, elements: elements.length }); model.destroy();
  }
  serverDoc.off('update', persist); serverDoc.destroy(); serverDoc = new Y.Doc(); Y.applyUpdate(serverDoc, store.loadDocument(board.id)!); serverDoc.on('update', persist);
  for (const update of offlineUpdates.slice()) Y.applyUpdate(serverDoc, update, 'late-offline');
  Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(serverDoc), 'reconnect');
  Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(offlineDoc), 'reconnect-cleanup');
  Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(serverDoc), 'reconnect-final');
  assert.equal(hash(raw(serverDoc)), hash(raw(offlineDoc)), 'Old offline replica raw convergence');
  assert.deepEqual(offline.read('cycle-0'), latestCycle, 'Stale generation must not affect recreated element');
  assert.equal(offline.read('offline-probe')!.x, 75); assert.equal(offline.read('offline-probe')!.y, 25); assert.equal(offline.read('offline-probe')!.style.fill, latestProbeFill);
  for (const element of offline.readAll()) assertValidElement(element);
  // Prove the old writer advances past the remote clock after reconnect.
  offline.updateStyle(['offline-probe'], { stroke: '#345678' });
  assert(offline.own.kv.get(CLOCK_KEY)!.stamp.clock > maxObservedClock);
  Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(offlineDoc), 'post-reconnect-edit');
  assert.equal(hash(raw(serverDoc)), hash(raw(offlineDoc)));
  const finalProjectionHash = hash(projection(offline));
  store.compact(board.id, Y.encodeStateAsUpdate(serverDoc)); compactions++;
  const assets = join(directory, 'assets'); mkdirSync(assets);
  const manifest = await createBackup(store, assets, secret, `${stem}.backup`); restoreBackup(`${stem}.backup`, `${stem}.restored`);
  const recoveredStore = new Store(join(`${stem}.restored`, 'whiteboard.sqlite'), secret), recoveredDoc = new Y.Doc(); Y.applyUpdate(recoveredDoc, recoveredStore.loadDocument(board.id)!);
  const recovered = new BoardDocument(recoveredDoc, { undo: false, initializeMetadata: false }), backupProjectionHash = hash(projection(recovered)), backupRawHash = hash(raw(recoveredDoc));
  assert.equal(backupProjectionHash, finalProjectionHash); assert.equal(backupRawHash, hash(raw(serverDoc))); recovered.destroy(); recoveredStore.close();
  const cpuUsed = process.cpuUsage(cpu), result = { startedAt, endedAt: Date.now(), elapsedMs: performance.now() - clock, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000, assumptions, sessionActors, gestures, historyUpdates, totalPersistedUpdates: actualUpdates, updateBytes, compactions, beforeReconnectStats, finalStats: inspect(serverDoc), storage: store.stats(board.id), checkpoints, loads, beforeReconnectRaw, expectedProjection, finalProjectionHash, backupProjectionHash, backupRawHash, backupDatabaseSha256: manifest.files['whiteboard.sqlite'], offlineAssertions: { rawConvergence: true, independentMoveAndStyle: true, staleGenerationExcluded: true, clockAdvancesAfterRejoin: true },
    passed: days === 180 && gestures === 108000 && historyUpdates >= 108000 && loads.every(load => load.milliseconds < 2000),
    limitation: 'This deliberately exposes retained retired-writer and old-generation records. Fixed-workload S3 boundedness does not imply indefinite churn is bounded. Reload times include SQLite read, Yjs apply, model construction and all visible element projection; hash checks are outside the timer. Three sequential OS-cache-warm reads.' };
  writeFileSync(`${stem}.json`, JSON.stringify(result, null, 2)); record({ type: 'complete', ...result }); console.log(JSON.stringify({ stem, ...result })); if (days === 180 && !result.passed) process.exitCode = 1;
} catch (error) { const failure = { failedAt: Date.now(), gestures, actualUpdates, error: error instanceof Error ? error.stack : String(error) }; writeFileSync(`${stem}.failure.json`, JSON.stringify(failure, null, 2)); throw error; }
finally { offline.destroy(); serverDoc.destroy(); store.close(); }
