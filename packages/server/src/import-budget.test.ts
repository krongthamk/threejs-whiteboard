import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import { createWhiteboardServer } from './server.js';

const secret = 'import-budget-test-secret-with-thirty-two-characters';
const password = 'import-budget-test-only-password';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(overrides: Partial<Parameters<typeof createWhiteboardServer>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-import-budget-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = createWhiteboardServer({ databasePath: join(directory, 'board.sqlite'), assetDirectory: join(directory, 'assets'), sessionSecret: secret, port: 0, ...overrides });
  cleanups.push(() => app.close()); await app.listen();
  const owner = app.store.createUser('owner', password), viewer = app.store.createUser('viewer', password), stranger = app.store.createUser('stranger', password);
  const tokens = Object.fromEntries(await Promise.all([owner, viewer, stranger].map(async user => [user.username, (await app.store.login(user.username, password))!.token])));
  const board = app.store.createBoard(owner.id, 'Import target'); app.store.setMember(board.id, viewer.id, 'viewer');
  const url = `http://127.0.0.1:${app.port}`, path = `/api/boards/${board.id}/import-budget`;
  const request = (token: string | undefined = tokens.owner, route = path, method = 'GET') => fetch(url + route, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { app, board, tokens, request, path };
}
async function until(check: () => boolean) {
  const start = performance.now(); while (!check()) { if (performance.now() - start > 5000) throw new Error('Budget synchronization timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function connect(app: Awaited<ReturnType<typeof setup>>['app'], boardId: string, token: string) {
  const doc = new Y.Doc(), socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: boardId, token, document: doc }); provider.attach();
  cleanups.push(() => { provider.destroy(); socket.destroy(); doc.destroy(); });
  await until(() => provider.isSynced); return { doc, provider, socket };
}
const vector = (base64: string) => Y.decodeStateVector(new Uint8Array(Buffer.from(base64, 'base64')));

test('import budget exposes actual custom caps only to authenticated members and stays no-store/read-only', async () => {
  const limits = { maxUpdateBytes: 4096, maxBoardBytes: 32768, maxInboundBytes: 8192, maxClockGrowth: 1234 };
  const { app, board, tokens, request } = await setup(limits), before = app.store.loadDocument(board.id)!;
  for (const token of [tokens.owner, tokens.viewer]) {
    const response = await request(token); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ limits: { ...limits, maxInboundMessages: 256 }, storage: { snapshotBytes: before.byteLength, updateBytes: 0 }, stateVector: expect.any(String) });
    const doc = new Y.Doc(); try { Y.applyUpdate(doc, before); expect(vector(body.stateVector)).toEqual(Y.decodeStateVector(Y.encodeStateVector(doc))); } finally { doc.destroy(); }
  }
  expect((await request('')).status).toBe(401); expect((await request('invalid')).status).toBe(401);
  expect((await request(tokens.stranger)).status).toBe(404);
  expect((await request(tokens.owner, '/api/boards/00000000-0000-0000-0000-000000000000/import-budget')).status).toBe(404);
  const head = await request(tokens.viewer, undefined, 'HEAD'); expect(head.status).toBe(200); expect(await head.text()).toBe(''); expect(head.headers.get('cache-control')).toBe('no-store');
  expect((await request(tokens.owner, undefined, 'POST')).status).toBe(404);
  expect(app.store.loadDocument(board.id)).toEqual(before); expect(app.store.stats(board.id).updateCount).toBe(0);
  expect(app.server.hocuspocus.documents.size).toBe(0);
});

test('import budget returns exact snapshot-plus-append counters rather than compacted Yjs size', async () => {
  const { app, board, request } = await setup();
  const doc = new Y.Doc(); cleanups.push(() => doc.destroy()); Y.applyUpdate(doc, app.store.loadDocument(board.id)!);
  const original = app.store.stats(board.id), writes: Uint8Array[] = [];
  doc.on('update', update => { writes.push(update); app.store.appendUpdate(board.id, update); });
  doc.getMap('meta').set('title', 'first title'); doc.getMap('meta').set('title', 'second title');
  const stats = app.store.stats(board.id), body = await (await request()).json();
  expect(stats.updateBytes).toBe(writes.reduce((sum, update) => sum + update.byteLength, 0));
  expect(body.storage).toEqual({ snapshotBytes: original.snapshotBytes, updateBytes: stats.updateBytes });
  expect(stats.snapshotBytes + stats.updateBytes).toBeGreaterThan(Y.encodeStateAsUpdate(doc).byteLength);
  expect(vector(body.stateVector)).toEqual(Y.decodeStateVector(Y.encodeStateVector(doc)));
  expect(app.store.stats(board.id)).toEqual(stats); expect(app.server.hocuspocus.documents.size).toBe(0);
  app.store.compact(board.id, Y.encodeStateAsUpdate(doc));
  expect((await (await request()).json()).storage).toEqual({ snapshotBytes: Y.encodeStateAsUpdate(doc).byteLength, updateBytes: 0 });
});

test('import budget uses loaded authoritative document vector and does not reload its persisted snapshot', async () => {
  const { app, board, tokens, request } = await setup(); await connect(app, board.id, tokens.owner!);
  const live = app.server.hocuspocus.documents.get(board.id)!;
  live.getMap('meta').set('title', 'live title'); await until(() => app.store.stats(board.id).updateCount > 0);
  const load = vi.spyOn(app.store, 'loadDocument').mockImplementation(() => { throw new Error('This live request must not load persistence'); });
  const response = await request(); expect(response.status).toBe(200); const body = await response.json();
  expect(vector(body.stateVector)).toEqual(Y.decodeStateVector(Y.encodeStateVector(live))); expect(load).not.toHaveBeenCalled();
  const loading = live.isLoading; live.isLoading = true;
  try { expect((await request()).status).toBe(503); } finally { live.isLoading = loading; }
});

test('import budget loads a disposable Y.Doc without initializing missing metadata', async () => {
  const { app, board, request } = await setup(), doc = new Y.Doc();
  const bytes = Y.encodeStateAsUpdate(doc); doc.destroy();
  app.store.db.prepare('UPDATE documents SET snapshot=? WHERE board_id=?').run(Buffer.from(bytes), board.id);
  const before = app.store.stats(board.id), response = await request(); expect(response.status).toBe(200);
  expect(vector((await response.json()).stateVector).size).toBe(0);
  expect(new Uint8Array(app.store.loadDocument(board.id)!)).toEqual(bytes); expect(app.store.stats(board.id)).toEqual(before); expect(app.server.hocuspocus.documents.size).toBe(0);
});

test('import budget fails closed for missing, corrupt, incomplete persistence and draining state', async () => {
  const { app, board, request } = await setup(), original = app.store.loadDocument(board.id)!;
  for (const bytes of [new Uint8Array([255]), (() => {
    const doc = new Y.Doc(), writes: Uint8Array[] = []; doc.on('update', update => writes.push(update));
    doc.getArray('history').push(['first']); doc.getArray('history').push(['second']); doc.destroy(); return writes[1]!;
  })(), (() => {
    const doc = new Y.Doc(), writes: Uint8Array[] = []; doc.on('update', update => writes.push(update));
    doc.getArray('history').push(['deleted']); doc.getArray('history').delete(0); doc.destroy(); return writes[1]!;
  })()]) {
    app.store.db.prepare('UPDATE documents SET snapshot=? WHERE board_id=?').run(Buffer.from(bytes), board.id);
    const response = await request(); expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(app.store.loadDocument(board.id)!)).toEqual(bytes);
  }
  app.store.db.prepare('UPDATE documents SET snapshot=? WHERE board_id=?').run(Buffer.from(original), board.id);
  const failed = vi.spyOn(app.store, 'loadDocument').mockImplementation(() => { throw new Error('SQLITE_IOERR'); });
  expect((await request()).status).toBe(503); failed.mockRestore();
  app.store.db.prepare('DELETE FROM documents WHERE board_id=?').run(board.id); expect((await request()).status).toBe(503);
  app.store.db.prepare('INSERT INTO documents(board_id,snapshot) VALUES (?,?)').run(board.id, Buffer.from(original));
  app.beginDrain(); expect((await request()).status).toBe(503); expect(app.store.loadDocument(board.id)).toEqual(original);
});

test('import budget refuses persistence-unhealthy state until retained live data is durably recovered', async () => {
  const { app, board, tokens, request } = await setup(), client = await connect(app, board.id, tokens.owner!);
  const healthy = app.store.createBoard(app.store.authenticate(tokens.owner!)!.user.id, 'Other healthy board');
  let reset: unknown; client.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); client.socket.disconnect(); });
  const append = vi.spyOn(app.store, 'appendUpdate').mockImplementation(() => { throw new Error('SQLITE_IOERR budget control'); });
  const compact = vi.spyOn(app.store, 'compact').mockImplementation(() => { throw new Error('SQLITE_IOERR budget recovery control'); });
  client.doc.getMap('meta').set('title', 'retained live edit'); await until(() => !!reset);
  expect((await request()).status).toBe(503); expect((await request(tokens.viewer)).status).toBe(503);
  expect((await request(tokens.owner, `/api/boards/${healthy.id}/import-budget`)).status).toBe(503);
  append.mockRestore(); compact.mockRestore(); await connect(app, board.id, tokens.owner!);
  const response = await request(); expect(response.status).toBe(200);
  const live = app.server.hocuspocus.documents.get(board.id)!;
  expect(vector((await response.json()).stateVector)).toEqual(Y.decodeStateVector(Y.encodeStateVector(live)));
});
