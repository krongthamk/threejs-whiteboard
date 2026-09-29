import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createWhiteboardServer } from '../../server/src/server.js';
import { BoardDocument, CLOCK_KEY, WRITER_PREFIX, assertValidElement, bindToElement, getElementBounds,
  resolveConnectorEndpoints, type Element, type ElementType } from '../../model/src/index.js';

const SEED = 0x51a7e;
const PAIRS = Number(process.env.LIVE_MODEL_PAIRS ?? 10_000);
const OFFLINE_MS = Number(process.env.LIVE_MODEL_OFFLINE_MS ?? 30_000);
assert(Number.isInteger(PAIRS) && PAIRS > 0); assert(Number.isInteger(OFFLINE_MS) && OFFLINE_MS >= 0);
const startedAt = new Date().toISOString(), started = performance.now();
const stamp = startedAt.replaceAll(':', '-').replaceAll('.', '-');
const stem = process.env.LIVE_MODEL_REPORT_STEM ?? `packages/model/reports/phase3-live/${stamp}`;
mkdirSync(dirname(stem), { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'whiteboard-live-model-'));
const sourceFiles = ['packages/model/src/document.ts', 'packages/model/src/schema.ts', 'packages/model/src/geometry.ts',
  'packages/server/src/server.ts', 'packages/server/src/store.ts', 'packages/loadtest/src/live-model-fuzz.ts', 'pnpm-lock.yaml'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const metadata = { startedAt, seed: SEED, requestedPairs: PAIRS, requestedOfflineMs: OFFLINE_MS, node: process.version, sourceHashes };
let phase = 'setup', completedPairs = 0, validatedElements = 0, offlineMeasuredMs = 0;
const operationCounts: Record<string, number> = {}, scenarios: string[] = [], maxClocks = [0, 0, 0];
const log = (data: unknown): void => { const line = JSON.stringify(data); appendFileSync(`${stem}.log`, `${line}\n`); console.log(line); };
const status = (state: string, extra: Record<string, unknown> = {}): void => writeFileSync(`${stem}.status.json`, `${JSON.stringify({ ...metadata, state, phase, completedPairs, validatedElements, elapsedMs: Math.round(performance.now() - started), ...extra }, null, 2)}\n`);
status('running');
const app = createWhiteboardServer({ databasePath: join(directory, 'board.sqlite'), assetDirectory: join(directory, 'assets'),
  sessionSecret: randomBytes(48).toString('hex'), port: Number(process.env.LIVE_MODEL_PORT ?? 3002) });
type Client = { board: BoardDocument; provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; userId: string; authFailures: string[] };
const clients: Client[] = [];
let boardId = '', rootUrl = '', closed = false;
async function until(check: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error(`${description} timed out in phase ${phase}, pair ${completedPairs}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const rawCache = new WeakMap<Y.Doc, { dirty: boolean; value: string }>();
function raw(doc: Y.Doc): string {
  let entry = rawCache.get(doc);
  if (!entry) { entry = { dirty: true, value: '' }; rawCache.set(doc, entry); doc.on('update', () => { entry!.dirty = true; }); }
  if (entry.dirty) {
    entry.value = JSON.stringify([...doc.share.keys()].filter(name => name.startsWith(WRITER_PREFIX)).sort().flatMap(name => {
      const array = doc.getArray(name); return array.length ? [[name, array.toArray()]] : [];
    })); entry.dirty = false;
  }
  return entry.value;
}
function serverDoc(): Y.Doc { const doc = app.server.hocuspocus.documents.get(boardId); assert(doc, 'Live server document missing'); return doc; }
async function settle(group: Client[] = clients): Promise<void> {
  await until(() => {
    for (const client of group) assert.deepEqual(client.authFailures, [], 'Unexpected authentication failure');
    if (group.some(client => !client.provider.isSynced || client.provider.hasUnsyncedChanges)) return false;
    const expected = raw(serverDoc());
    return group.every(client => raw(client.board.doc) === expected);
  }, 'Acknowledgement and exact server/client convergence');
}
function validate(group: Client[] = clients): void {
  const expected = canonical(group[0]!.board.readAll());
  for (const client of group) {
    const elements = client.board.readAll(), map = new Map(elements.map(element => [element.id, element]));
    assert.equal(map.size, elements.length, 'Duplicate element identity');
    for (const element of elements) {
      assertValidElement(element);
      if (element.type === 'stroke') {
        const xs = element.props.points.filter((_, i) => i % 3 === 0), ys = element.props.points.filter((_, i) => i % 3 === 1);
        assert.deepEqual([element.x, element.y, element.w, element.h], [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]);
      }
      if (element.type === 'connector') for (const endpoint of resolveConnectorEndpoints(element, map)) assert(Number.isFinite(endpoint.x) && Number.isFinite(endpoint.y));
      const bounds = getElementBounds(element, map);
      assert([bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) && bounds.w >= 0 && bounds.h >= 0);
      validatedElements++;
    }
    assert.equal(canonical(elements), expected, 'Semantic projections diverged');
    const index = clients.indexOf(client), clock = client.board.own.kv.get(CLOCK_KEY)?.stamp.clock ?? 0;
    assert(clock >= maxClocks[index]!, 'Writer clock decreased'); maxClocks[index] = clock;
  }
}
async function request(path: string, token: string | undefined, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${rootUrl}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function jsonRequest<T>(path: string, token: string | undefined, method: string, body: unknown, expectedStatus: number): Promise<T> {
  const response = await request(path, token, method, body); assert.equal(response.status, expectedStatus, `${method} ${path}`);
  return response.json() as Promise<T>;
}
async function connect(token: string, userId: string, clientID: number): Promise<Client> {
  const doc = new Y.Doc(); doc.clientID = clientID;
  const authFailures: string[] = [];
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: boardId, token, document: doc,
    onAuthenticationFailed: ({ reason }) => authFailures.push(reason) });
  provider.attach();
  await until(() => { assert.deepEqual(authFailures, []); return provider.isSynced; }, 'Authenticated provider synchronization');
  const client = { board: new BoardDocument(doc), provider, socket, userId, authFailures }; clients.push(client);
  await settle(); return client;
}
function randomGenerator(seed: number): () => number { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n; return ((n ^ n >>> 14) >>> 0) / 4294967296; }; }
const random = randomGenerator(SEED), integer = (n: number) => Math.floor(random() * n);
const choose = <T>(values: readonly T[]): T => values[integer(values.length)]!;
const types: readonly ElementType[] = ['rect', 'ellipse', 'sticky', 'text', 'stroke', 'connector', 'image'];
const coordinate = () => integer(2000) - 1000;
const count = (name: string) => { operationCounts[name] = (operationCounts[name] ?? 0) + 1; };
function operation(board: BoardDocument, sequence: number): void {
  const all = board.readAll(), element = choose(all), type = choose(types), action = integer(15);
  if (action === 13 && board.undoManager.undoStack.length) { board.undoManager.undo(); count('undo'); return; }
  if (action === 14 && board.undoManager.redoStack.length) { board.undoManager.redo(); count('redo'); return; }
  if (all.length < 10 || action === 0 && all.length < 48) { board.create(type, { id: `new-${sequence}`, x: coordinate(), y: coordinate() }); count('create'); return; }
  if (action === 1 && all.length > 10) { board.delete(element.id); count('delete'); return; }
  if (action === 2) { board.move([element.id], { x: integer(41) - 20, y: integer(41) - 20 }); count('move'); return; }
  if (action === 3) { board.updateStyle([element.id], { fill: `#${integer(0x1000000).toString(16).padStart(6, '0')}`, opacity: random(), strokeWidth: integer(16), fontSize: 8 + integer(50) }); count('style'); return; }
  if (action === 4) { board.update(element.id, { w: 1 + integer(500), h: 1 + integer(500) }); count('resize'); return; }
  if (action === 5) { board.update(element.id, { rotation: random() * Math.PI * 2 }); count('rotate'); return; }
  if (action === 6) { board.reorder(element.id, choose(['forward', 'backward', 'front', 'back'] as const)); count('order'); return; }
  if (action === 7) { const target = choose(all.filter(e => e.type === 'text' || e.type === 'sticky')); if (target) { board.update(target.id, { props: { text: `Live ${sequence}\nΩ中 🖊️`, align: choose(['left', 'center', 'right'] as const), autoSize: random() > .5 } }); count('text'); return; } }
  if (action === 8) { const target = choose(all.filter(e => e.type === 'stroke')); if (target) { board.update(target.id, { props: { points: Array.from({ length: 1 + integer(15) }, () => [coordinate(), coordinate(), random()]).flat(), simplified: random() > .5 } }); count('stroke'); return; } }
  if (action === 9) { const target = choose(all.filter(e => e.type === 'connector')), anchor = choose(all.filter(e => e.type !== 'connector')); if (target && anchor) { board.update(target.id, { props: { start: bindToElement(anchor, random(), random()), end: { x: coordinate(), y: coordinate() }, kind: choose(['straight', 'elbow', 'curve'] as const) } }); count('binding'); return; } }
  if (action === 10) { const target = choose(all.filter(e => e.type === 'image')); if (target) { board.update(target.id, { props: { assetId: `asset-${sequence}`, naturalW: 1 + integer(3000), naturalH: 1 + integer(2000) } }); count('image'); return; } }
  if (action === 11) { board.transact(() => { for (const target of all.slice(0, 3)) board.update(target.id, { x: coordinate(), y: coordinate() }); }); count('multi-element gesture'); return; }
  board.update(element.id, { x: coordinate(), y: coordinate() }); count('position');
}
async function undoScenarios(): Promise<void> {
  const [a, b, c] = clients.map(client => client.board) as [BoardDocument, BoardDocument, BoardDocument];
  a.create('rect', { id: 'undo-probe' }); await settle(); clients.forEach(client => client.board.undoManager.clear());
  a.move(['undo-probe'], { x: 25, y: 35 }); b.updateStyle(['undo-probe'], { fill: '#ff0000' }); await settle();
  assert.equal(c.undoManager.undoStack.length, 0, 'Remote writes entered uninvolved user history');
  assert.equal(a.read('undo-probe')!.x, 25); assert.equal(a.read('undo-probe')!.style.fill, '#ff0000');
  a.undoManager.undo(); await settle(); assert.equal(a.read('undo-probe')!.x, 0); assert.equal(a.read('undo-probe')!.style.fill, '#ff0000');
  a.undoManager.redo(); await settle(); assert.equal(a.read('undo-probe')!.x, 25); assert.equal(a.read('undo-probe')!.style.fill, '#ff0000');
  scenarios.push('independent move/recolor with per-user undo and redo');
  a.updateStyle(['undo-probe'], { fill: '#00ff00' }); await settle(); b.updateStyle(['undo-probe'], { fill: '#0000ff' }); await settle();
  a.undoManager.undo(); await settle(); assert.equal(a.read('undo-probe')!.style.fill, '#0000ff');
  a.undoManager.redo(); await settle(); assert.equal(a.read('undo-probe')!.style.fill, '#0000ff');
  scenarios.push('newer peer value survives local undo and stale redo');
  a.updateStyle(['undo-probe'], { fill: '#ff0000' }); b.updateStyle(['undo-probe'], { fill: '#00ff00' }); await settle();
  const winner = a.read('undo-probe')!.style.fill === '#ff0000' ? a : b, peerFill = winner === a ? '#00ff00' : '#ff0000';
  winner.undoManager.undo(); await settle(); assert.equal(a.read('undo-probe')!.style.fill, peerFill);
  scenarios.push('undoing a concurrent winning register reveals peer value');
  clients.forEach(client => client.board.undoManager.clear());
  const before = a.read('undo-probe')!;
  a.delete('undo-probe'); b.move(['undo-probe'], { x: 80, y: 25 }); await settle(); assert.equal(a.read('undo-probe'), undefined);
  a.undoManager.undo(); await settle(); assert.equal(a.read('undo-probe')!.x, before.x + 80); assert.equal(a.read('undo-probe')!.y, before.y + 25);
  a.undoManager.redo(); await settle(); assert.equal(a.read('undo-probe'), undefined);
  a.undoManager.undo(); await settle(); assert.equal(a.read('undo-probe')!.x, before.x + 80);
  scenarios.push('delete/remote-move restoration with repeated native history');
  a.delete('undo-probe'); await settle(); clients.forEach(client => client.board.undoManager.clear()); validate();
}
async function offlineScenario(): Promise<void> {
  phase = 'offline'; status('running');
  const [offline, online, third] = clients as [Client, Client, Client];
  offline.board.create('rect', { id: 'offline-shared' }); await settle();
  offline.socket.disconnect();
  await until(() => (!offline.socket.webSocket || offline.socket.webSocket.readyState === WebSocket.CLOSED) && app.server.hocuspocus.documents.get(boardId)!.getConnectionsCount() === 2, 'Actual socket disconnection');
  const intervalStart = performance.now();
  offline.board.move(['offline-shared'], { x: 75, y: 25 });
  offline.board.create('sticky', { id: 'offline-created', props: { text: 'Saved while offline', align: 'left', autoSize: false } });
  online.board.updateStyle(['offline-shared'], { fill: '#0055ff' }); online.board.create('ellipse', { id: 'online-created' });
  third.board.create('text', { id: 'third-created', props: { text: 'Third authenticated user', align: 'left', autoSize: true } });
  await settle([online, third]);
  while (performance.now() - intervalStart < OFFLINE_MS) {
    assert(!offline.socket.webSocket || offline.socket.webSocket.readyState !== WebSocket.OPEN, 'Offline socket reopened early');
    assert.equal(online.board.read('offline-created'), undefined); assert.equal(offline.board.read('online-created'), undefined);
    assert.equal(online.board.read('offline-shared')!.x, 0); assert(offline.provider.hasUnsyncedChanges);
    const elapsed = performance.now() - intervalStart;
    if (Math.floor(elapsed / 10_000) !== Math.floor((elapsed - 1000) / 10_000)) log({ phase, offlineElapsedMs: Math.round(elapsed) });
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, OFFLINE_MS - elapsed))));
  }
  offlineMeasuredMs = performance.now() - intervalStart; assert(offlineMeasuredMs >= OFFLINE_MS);
  await offline.socket.connect(); await settle(); validate();
  for (const client of clients) {
    assert.equal(client.board.read('offline-shared')!.x, 75); assert.equal(client.board.read('offline-shared')!.y, 25);
    assert.equal(client.board.read('offline-shared')!.style.fill, '#0055ff');
    assert(client.board.read('offline-created')); assert(client.board.read('online-created')); assert(client.board.read('third-created'));
  }
  scenarios.push('measured socket-offline interval merges local and both peer edits after reconnect');
}
async function cleanup(): Promise<void> {
  if (closed) return; closed = true;
  for (const client of clients) { client.provider.destroy(); client.socket.destroy(); client.board.destroy(); }
  await app.close();
}
try {
  await app.listen(); rootUrl = `http://127.0.0.1:${app.port}`;
  const password = randomBytes(24).toString('hex');
  const usernames = ['live-owner', 'live-editor-a', 'live-editor-b', 'live-outsider'];
  for (const username of usernames) app.store.createUser(username, password);
  const sessions = [];
  for (const username of usernames) sessions.push(await jsonRequest<{ token: string; user: { id: string } }>('/api/session', undefined, 'POST', { username, password }, 200));
  const boardResponse = await jsonRequest<{ board: { id: string } }>('/api/boards', sessions[0]!.token, 'POST', { title: 'Phase 3 live model acceptance' }, 201);
  boardId = boardResponse.board.id;
  for (const username of usernames.slice(1, 3)) assert.equal((await request(`/api/boards/${boardId}/members`, sessions[0]!.token, 'POST', { username, role: 'editor' })).status, 204);
  assert.equal((await request(`/api/boards/${boardId}`, undefined)).status, 401);
  assert.equal((await request(`/api/boards/${boardId}`, sessions[3]!.token)).status, 404);
  for (let index = 0; index < 3; index++) await connect(sessions[index]!.token, sessions[index]!.user.id, (index + 1) * 101);
  assert.equal(new Set(clients.map(client => client.userId)).size, 3); scenarios.push('real provisioning, HTTP sessions and membership authorization');
  phase = 'undo'; await undoScenarios(); log({ phase, scenarios });
  phase = 'fuzz'; clients[0]!.board.transact(() => { for (let index = 0; index < 28; index++) clients[0]!.board.create(types[index % types.length]!, { id: `base-${index}`, x: index * 20, y: index * 10 }); });
  await settle(); clients.forEach(client => client.board.undoManager.clear());
  const fuzzStarted = performance.now();
  for (let pair = 0; pair < PAIRS; pair++) {
    const a = integer(3), b = (a + 1 + integer(2)) % 3;
    // No await between these calls: neither client can receive the other's network update first.
    operation(clients[a]!.board, pair * 2); operation(clients[b]!.board, pair * 2 + 1);
    await settle(); validate(); completedPairs = pair + 1;
    if (pair % 200 === 0) clients.forEach(client => client.board.undoManager.clear());
    if (completedPairs % 1000 === 0 || completedPairs === PAIRS) { status('running'); log({ phase, completedPairs, validatedElements, elapsedMs: Math.round(performance.now() - fuzzStarted), storage: app.store.stats(boardId) }); }
  }
  assert.equal(Object.values(operationCounts).reduce((sum, count) => sum + count, 0), PAIRS * 2);
  if (PAIRS >= 10_000) assert.deepEqual(Object.keys(operationCounts).sort(), ['binding', 'create', 'delete', 'image', 'move', 'multi-element gesture', 'order', 'position', 'redo', 'resize', 'rotate', 'stroke', 'style', 'text', 'undo'].sort());
  const fuzzDurationMs = Math.round(performance.now() - fuzzStarted);
  await offlineScenario(); phase = 'persistence'; await settle();
  const persistedBytes = app.store.loadDocument(boardId); assert(persistedBytes);
  const reloadedDoc = new Y.Doc(); Y.applyUpdate(reloadedDoc, persistedBytes, 'persisted-reload');
  const reloaded = new BoardDocument(reloadedDoc, { undo: false });
  assert.equal(raw(reloadedDoc), raw(serverDoc()), 'SQLite reload differs from live raw state');
  assert.equal(canonical(reloaded.readAll()), canonical(clients[0]!.board.readAll()), 'SQLite reload differs from semantic state');
  const finalHash = createHash('sha256').update(canonical(reloaded.readAll())).digest('hex');
  const finalElements = reloaded.readAll().length; reloaded.destroy();
  writeFileSync(`${stem}.final-update.bin`, persistedBytes);
  scenarios.push('SQLite snapshot/log reload preserves exact raw and semantic state');
  const result = { ...metadata, passed: true, acceptanceRun: PAIRS === 10_000 && OFFLINE_MS >= 30_000, concurrentPairs: completedPairs,
    authenticatedUsers: 3, operations: PAIRS * 2, operationCounts, validatedElements, invalidElements: 0, divergentPairs: 0,
    offlineMeasuredMs, fuzzDurationMs, durationMs: Math.round(performance.now() - started), scenarios, finalElements, finalHash,
    persistedSnapshotBytes: persistedBytes.byteLength, storage: app.store.stats(boardId), serverMetrics: app.metrics.get(boardId), artifactStem: stem };
  await cleanup(); phase = 'complete'; writeFileSync(`${stem}.result.json`, `${JSON.stringify(result, null, 2)}\n`); status('passed', { exitCode: 0, resultFile: `${stem}.result.json` }); log(result);
} catch (error) {
  const failure = { error: error instanceof Error ? error.stack : String(error), operationCounts, scenarios, dataDirectory: directory };
  status('failed', { exitCode: 1, ...failure }); log({ phase, completedPairs, ...failure });
  try { await cleanup(); } catch (cleanupError) { log({ cleanupError: String(cleanupError) }); }
  process.exitCode = 1;
}
