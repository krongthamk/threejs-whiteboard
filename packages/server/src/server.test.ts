import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import { createWhiteboardServer } from './server.js';
import { Store } from './store.js';
import { BoardDocument, assertValidElement, createElement, WRITER_PREFIX } from '../../model/src/index.js';
import { createBackup, restoreBackup } from './operations.js';
import { createRouter, shardFor } from './router.js';

const secret = 'test-secret-with-at-least-thirty-two-characters';
const password = 'a-long-test-password';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'whiteboard-server-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; }
async function setup(overrides: Partial<Parameters<typeof createWhiteboardServer>[0]> = {}) {
  const path = directory(), options = { databasePath: join(path, 'board.sqlite'), assetDirectory: join(path, 'assets'), sessionSecret: secret, port: 0, ...overrides };
  const app = createWhiteboardServer(options); await app.listen(); cleanups.push(() => app.close());
  const owner = app.store.createUser('owner', password), editor = app.store.createUser('editor', password), viewer = app.store.createUser('viewer', password), stranger = app.store.createUser('stranger', password);
  const tokens = Object.fromEntries([owner, editor, viewer, stranger].map(user => [user.username, app.store.login(user.username, password)!.token]));
  const board = app.store.createBoard(owner.id, 'Private board'); app.store.setMember(board.id, editor.id, 'editor'); app.store.setMember(board.id, viewer.id, 'viewer');
  const url = `http://127.0.0.1:${app.port}`;
  function request(path: string, token = tokens.owner!, init: RequestInit = {}) {
    return fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  }
  return { app, options, owner, editor, viewer, stranger, tokens, board, url, request };
}
async function until(check: () => boolean, timeout = 8000) { const start = performance.now(); while (!check()) { if (performance.now() - start > timeout) throw new Error('Synchronization timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function client(port: number, board: string, token: string, doc = new Y.Doc(), headers?: Record<string, string>, parameters?: Record<string, string>) {
  let authenticationFailure = '';
  const WebSocketPolyfill = headers ? class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols, { headers }); } } : WebSocket;
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collaboration?${new URLSearchParams(parameters)}`, WebSocketPolyfill });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: board, token, document: doc, onAuthenticationFailed: ({ reason }) => { authenticationFailure = reason; } });
  provider.attach();
  cleanups.push(() => { provider.destroy(); socket.destroy(); doc.destroy(); });
  await until(() => { if (authenticationFailure) throw new Error(`Authentication failed: ${authenticationFailure}`); return provider.isSynced; });
  return { doc, provider, socket };
}

test('signed sessions, board membership, title updates, CSRF and logout use one ACL', async () => {
  const { request, board, tokens, url } = await setup();
  expect((await fetch(`${url}/api/boards`)).status).toBe(401);
  expect((await request(`/api/boards/${board.id}`, tokens.stranger)).status).toBe(404);
  expect(await (await request('/api/boards', tokens.viewer)).json()).toMatchObject({ boards: [{ id: board.id, role: 'viewer' }] });
  expect((await request(`/api/boards/${board.id}`, tokens.viewer, { method: 'PATCH', body: JSON.stringify({ title: 'Forbidden' }) })).status).toBe(403);
  expect(await (await request(`/api/boards/${board.id}`, tokens.editor, { method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) })).json()).toMatchObject({ board: { title: 'Renamed', role: 'editor' } });
  expect((await request(`/api/boards/${board.id}/members`, tokens.editor, { method: 'POST', body: JSON.stringify({ username: 'stranger', role: 'viewer' }) })).status).toBe(403);
  expect((await request('/api/boards', tokens.owner, { method: 'POST', headers: { Origin: 'https://evil.invalid' }, body: JSON.stringify({ title: 'Cross origin' }) })).status).toBe(403);
  const signedIn = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4173' }, body: JSON.stringify({ username: 'owner', password }) });
  const session = await signedIn.json() as { user: { username: string }; expiresAt: number };
  expect(session.user.username).toBe('owner'); expect(session.expiresAt).toBeGreaterThan(Date.now());
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
  const sessionToken = decodeURIComponent(cookie.slice('board_session='.length));
  expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await fetch(`${url}/api/boards`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Missing origin' }) })).status).toBe(403);
  expect((await fetch(`${url}/api/boards`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:4173', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Cookie board' }) })).status).toBe(201);
  expect((await request('/api/session', `${sessionToken}tampered`)).status).toBe(401);
  expect((await request('/api/session/logout', sessionToken, { method: 'POST' })).status).toBe(204);
  expect((await request('/api/session', sessionToken)).status).toBe(401);
});

test('static production defaults deny development origins while approved cookie sessions remain usable', async () => {
  const staticDirectory = directory(); writeFileSync(join(staticDirectory, 'index.html'), '<html>Static</html>');
  const { url, tokens } = await setup({ staticDirectory }); const cookie = `board_session=${encodeURIComponent(tokens.owner!)}`;
  const denied = await fetch(`${url}/api/session`, { headers: { Cookie: cookie, Origin: 'http://localhost:5173' } });
  expect(denied.status).toBe(403); expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  const approved = await fetch(`${url}/api/session`, { headers: { Cookie: cookie, Origin: 'http://localhost:3001' } });
  expect(approved.status).toBe(200); expect(approved.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
});

test('credential and restored session JSON expose identity and expiry without any bearer token', async () => {
  const { url, tokens } = await setup();
  const login = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4173' }, body: JSON.stringify({ username: 'owner', password }) });
  expect(login.status).toBe(200); const data = await login.json(); expect(data).not.toHaveProperty('token');
  expect(data).toMatchObject({ user: { username: 'owner' }, expiresAt: expect.any(Number) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  const sessionHeaders: Record<string, string>[] = [{ Cookie: cookie, Origin: 'http://localhost:4173' }, { Authorization: `Bearer ${tokens.owner}` }];
  for (const headers of sessionHeaders) {
    const restored = await fetch(`${url}/api/session`, { headers }); expect(restored.status).toBe(200);
    const restoredData = await restored.json(); expect(restoredData).not.toHaveProperty('token');
    expect(restoredData).toMatchObject({ user: data.user, expiresAt: expect.any(Number) });
  }
});

test('empty provider authentication frames use approved cookies through direct and routed WebSockets', async () => {
  const { app, board, tokens } = await setup();
  const headers = { Cookie: `board_session=${encodeURIComponent(tokens.owner!)}`, Origin: 'http://localhost:4173' };
  const direct = await client(app.port, board.id, '', new Y.Doc(), headers);
  direct.doc.getMap('cookie-auth').set('direct', true); await until(() => !direct.provider.hasUnsyncedChanges);
  const router = createRouter([{ id: 'local', url: `http://127.0.0.1:${app.port}` }], { port: 0 }); await router.listen(); cleanups.push(() => router.close());
  const routed = await client(router.port, board.id, '', new Y.Doc(), headers);
  expect(routed.doc.getMap('cookie-auth').get('direct')).toBe(true);
  routed.doc.getMap('cookie-auth').set('routed', true); await until(() => direct.doc.getMap('cookie-auth').get('routed') === true);
  await expect(client(app.port, board.id, '', new Y.Doc(), { Origin: 'http://localhost:4173' })).rejects.toThrow('Authentication failed');
  await expect(client(app.port, board.id, '', new Y.Doc(), { ...headers, Origin: 'https://evil.invalid' })).rejects.toThrow('Authentication failed');
});

test('a cookie account switch cannot replay another unexpired principal cache, which survives correct-account retry', async () => {
  const { app, board, owner, editor, tokens } = await setup();
  const online = await client(app.port, board.id, tokens.owner!);
  const cachedOwner = new Y.Doc(); Y.applyUpdate(cachedOwner, Y.encodeStateAsUpdate(online.doc)); cachedOwner.getMap('principal-cache').set('owner-pending', 'private local work');
  const before = app.store.stats(board.id);
  const changedCookie = { Cookie: `board_session=${encodeURIComponent(tokens.editor!)}`, Origin: 'http://localhost:4173' };
  // Both accounts are authorized for this board; the replica's principal is
  // nevertheless still the owner whose unexpired session opened this cache.
  expect(app.store.authenticate(tokens.owner!)!.expiresAt).toBeGreaterThan(Date.now() + 60_000);
  expect(app.store.role(board.id, editor.id)).toBe('editor');
  const attempted = await client(app.port, board.id, '', cachedOwner, changedCookie, { expectedUserId: owner.id }).then(() => 'authenticated', error => String(error));
  expect(attempted).toContain('session-identity-changed');
  expect(app.store.stats(board.id)).toEqual(before); expect(online.doc.getMap('principal-cache').size).toBe(0);
  expect(cachedOwner.getMap('principal-cache').get('owner-pending')).toBe('private local work');
  const correctCookie = { ...changedCookie, Cookie: `board_session=${encodeURIComponent(tokens.owner!)}` };
  const recovered = await client(app.port, board.id, '', cachedOwner, correctCookie, { expectedUserId: owner.id });
  await until(() => !recovered.provider.hasUnsyncedChanges && online.doc.getMap('principal-cache').get('owner-pending') === 'private local work');
});

test('assets require source read and target edit permissions, and copies retain the same bytes', async () => {
  const { app, request, board, tokens, stranger } = await setup();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const upload = await request(`/api/boards/${board.id}/assets`, tokens.editor, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
  expect(upload.status).toBe(201); const asset = await upload.json() as { assetId: string; url: string };
  expect((await request(asset.url, tokens.stranger)).status).toBe(404);
  expect(Buffer.from(await (await request(asset.url, tokens.viewer)).arrayBuffer())).toEqual(bytes);
  const target = app.store.createBoard(stranger.id, 'Target');
  const copyPath = `/api/boards/${target.id}/assets/copy`, body = JSON.stringify({ sourceBoardId: board.id, assetId: asset.assetId });
  expect((await request(copyPath, tokens.stranger, { method: 'POST', body })).status).toBe(404);
  app.store.setMember(board.id, stranger.id, 'viewer');
  const copy = await request(copyPath, tokens.stranger, { method: 'POST', body }); expect(copy.status).toBe(201);
  const copied = await copy.json() as { assetId: string; url: string }; expect(copied.assetId).not.toBe(asset.assetId);
  expect(Buffer.from(await (await request(copied.url, tokens.stranger)).arrayBuffer())).toEqual(bytes);
  expect((await request(`/api/boards/${board.id}/assets`, tokens.viewer, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes })).status).toBe(403);
  expect((await request(`/api/boards/${board.id}/assets`, tokens.owner, { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' })).status).toBe(415);
});

test('real WebSocket edits persist, viewers cannot write, and revoked sessions cannot keep editing', async () => {
  const { app, options, board, tokens } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!), viewer = await client(app.port, board.id, tokens.viewer!);
  let viewerRejection: any, revokedRejection: any;
  viewer.provider.on('stateless', ({ payload }: { payload: string }) => { viewerRejection = JSON.parse(payload); viewer.socket.disconnect(); });
  owner.provider.on('stateless', ({ payload }: { payload: string }) => { revokedRejection = JSON.parse(payload); owner.socket.disconnect(); });
  owner.doc.getMap('test').set('position', 123);
  await until(() => viewer.doc.getMap('test').get('position') === 123 && app.store.stats(board.id).updateCount > 0);
  viewer.doc.getMap('test').set('forbidden', true);
  await until(() => !!viewerRejection);
  expect(viewerRejection).toMatchObject({ type: 'permission-changed', role: 'viewer', resetRequired: true, reason: 'read-only-write-rejected' });
  expect(owner.doc.getMap('test').get('forbidden')).toBeUndefined();
  const session = app.store.authenticate(tokens.owner!)!; app.store.logout(session.sessionId);
  owner.doc.getMap('test').set('afterRevoke', true);
  await until(() => !!revokedRejection);
  expect(revokedRejection).toMatchObject({ type: 'permission-changed', role: null, resetRequired: true });
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, app.store.loadDocument(board.id)!);
  expect(persisted.getMap('test').toJSON()).toEqual({ position: 123 }); persisted.destroy();
  owner.provider.destroy(); owner.socket.destroy(); viewer.provider.destroy(); viewer.socket.destroy();
  await app.close();
  const restarted = createWhiteboardServer(options); await restarted.listen(); cleanups.push(() => restarted.close());
  const recovered = await client(restarted.port, board.id, tokens.editor!);
  expect(recovered.doc.getMap('test').toJSON()).toEqual({ position: 123 });
});

test('a failed update keeps the listener and replicas alive, and reconnect persists the retained state', async () => {
  const { app, board, tokens, request } = await setup();
  const author = await client(app.port, board.id, tokens.owner!), peer = await client(app.port, board.id, tokens.editor!);
  const resets: unknown[] = [];
  for (const replica of [author, peer]) replica.provider.on('stateless', ({ payload }: { payload: string }) => {
    resets.push(JSON.parse(payload)); replica.socket.disconnect();
  });
  const retained = app.server.hocuspocus.documents.get(board.id)!;
  const append = vi.spyOn(app.store, 'appendUpdate').mockImplementationOnce(() => { throw new Error('SQLITE_FULL'); });
  // Keep storage unavailable through the immediate store hook, then recover.
  const compact = vi.spyOn(app.store, 'compact').mockImplementation(() => { throw new Error('SQLITE_FULL'); });
  cleanups.push(() => { append.mockRestore(); compact.mockRestore(); });
  author.doc.getMap('storage-error').set('saved-locally', 'must survive');
  await until(() => resets.length === 2, 1000);
  expect(resets).toEqual(expect.arrayContaining([
    expect.objectContaining({ boardId: board.id, reason: 'persistence-failed', role: 'owner', resetRequired: true }),
    expect.objectContaining({ boardId: board.id, reason: 'persistence-failed', role: 'editor', resetRequired: true }),
  ]));
  expect((await request('/health')).status).toBe(200);
  expect((await request('/ready')).status).toBe(503);
  await app.server.hocuspocus.unloadDocument(retained);
  expect(app.server.hocuspocus.documents.get(board.id)).toBe(retained);
  expect(author.doc.getMap('storage-error').get('saved-locally')).toBe('must survive');
  // The update is already in the server Doc: replay alone emits no change hook.
  // Authenticate a fresh socket and require a durable full-state recovery.
  compact.mockRestore();
  const reconnected = await client(app.port, board.id, tokens.editor!);
  expect(reconnected.doc.getMap('storage-error').get('saved-locally')).toBe('must survive');
  expect((await request('/ready')).status).toBe(200);
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, app.store.loadDocument(board.id)!);
  expect(persisted.getMap('storage-error').get('saved-locally')).toBe('must survive'); persisted.destroy();
});

test('the entry point logs an unhandled rejection and drains instead of crashing', async () => {
  const path = directory();
  const child = fork(fileURLToPath(new URL('./rejection-fixture.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, WHITEBOARD_DATA_DIR: path, PORT: '0', WHITEBOARD_DRAIN_MS: '2000' },
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null); }
  });
  let output = '', errors = '';
  child.stdout!.on('data', bytes => { output += bytes.toString(); });
  child.stderr!.on('data', bytes => { errors += bytes.toString(); });
  await until(() => output.includes('"event":"ready"'));
  const ready = JSON.parse(output.trim().split('\n').find(line => line.includes('"event":"ready"'))!);
  child.send({ type: 'reject' });
  await until(() => errors.includes('unhandled-rejection') || child.exitCode !== null);
  expect(errors).toContain('unhandled-rejection');
  expect((await fetch(`http://127.0.0.1:${ready.port}/ready`)).status).toBe(503);
  expect((await fetch(`http://127.0.0.1:${ready.port}/health`)).status).toBe(200);
  await until(() => child.exitCode !== null || child.signalCode !== null);
  expect(child.exitCode).toBe(0);
});

test('compaction failures retain the document until storage recovers', async () => {
  const { app, board, tokens, request } = await setup();
  const author = await client(app.port, board.id, tokens.owner!);
  let reset: any;
  author.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); author.socket.disconnect(); });
  app.store.db.prepare('UPDATE documents SET update_count=10000 WHERE board_id=?').run(board.id);
  const compact = vi.spyOn(app.store, 'compact').mockImplementation(() => { throw new Error('SQLITE_IOERR'); });
  cleanups.push(() => compact.mockRestore());
  author.doc.getMap('compaction-error').set('retained', true);
  await until(() => !!reset, 1000);
  expect(reset.reason).toBe('persistence-failed');
  const retained = app.server.hocuspocus.documents.get(board.id)!;
  await app.server.hocuspocus.unloadDocument(retained);
  expect(app.server.hocuspocus.documents.get(board.id)).toBe(retained);
  expect((await request('/ready')).status).toBe(503);
  await expect(client(app.port, board.id, tokens.owner!)).rejects.toThrow('Authentication failed: persistence-failed');
  compact.mockRestore();
  const reconnected = await client(app.port, board.id, tokens.owner!);
  expect(reconnected.doc.getMap('compaction-error').get('retained')).toBe(true);
  expect((await request('/ready')).status).toBe(200);
});

test.each(['element', 'key', 'stamp', 'primitive', 'schema', 'clock'] as const)('rejects an editor update with malformed %s before it enters the live document', async malformed => {
  const { app, board, tokens } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  const healthy = new BoardDocument(owner.doc); cleanups.push(() => healthy.destroy());
  healthy.create('rect', { id: 'healthy' });
  await until(() => !owner.provider.hasUnsyncedChanges);
  const before = app.store.stats(board.id).updateCount;
  let reset: any;
  editor.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); editor.socket.disconnect(); });
  const actor = String(editor.doc.clientID);
  const record: any = { key: JSON.stringify(['bad', '$base']), val: { stamp: { actor, clock: 1 }, value: { generation: `${actor}:0`, element: createElement('rect', { id: 'bad' }) } } };
  editor.doc.transact(() => {
    if (malformed === 'schema') editor.doc.getMap('meta').set('schemaVersion', 99);
    else {
      if (malformed === 'element') record.val.value.element.x = 'nope';
      if (malformed === 'key') record.key = 'not-json';
      if (malformed === 'stamp') delete record.val.stamp;
      if (malformed === 'clock') record.val.stamp.clock = Number.MAX_SAFE_INTEGER;
      editor.doc.getArray(WRITER_PREFIX + actor).push([malformed === 'primitive' ? null : record]);
    }
  });
  await until(() => !!reset, 1000);
  expect(reset).toMatchObject({ boardId: board.id, role: 'editor', resetRequired: true, reason: 'invalid-document-update' });
  expect(app.store.stats(board.id).updateCount).toBe(before);
  expect(healthy.readAll().map(element => element.id)).toEqual(['healthy']);
  const live = app.server.hocuspocus.documents.get(board.id)!;
  expect(live.getMap('meta').get('schemaVersion')).toBe(2);
  expect(live.share.has(WRITER_PREFIX + actor)).toBe(false);
  healthy.create('ellipse', { id: 'follow-up' });
  await until(() => !owner.provider.hasUnsyncedChanges);
  expect(healthy.readAll().map(element => element.id)).toEqual(['healthy', 'follow-up']);
});

test('prune-element repairs malformed raw bases offline and stale replicas cannot resurrect them', async () => {
  const path = directory(), store = new Store(join(path, 'whiteboard.sqlite'), secret);
  cleanups.push(() => store.close());
  const user = store.createUser('repair-owner', password), board = store.createBoard(user.id, 'Repair');
  const doc = new Y.Doc(); Y.applyUpdate(doc, store.loadDocument(board.id)!);
  const model = new BoardDocument(doc); model.create('rect', { id: 'healthy' });
  const actor = 'poison-writer', records = doc.getArray(WRITER_PREFIX + actor);
  const bad = { key: JSON.stringify(['bad', '$base']), val: { stamp: { actor, clock: Number.MAX_SAFE_INTEGER }, value: { generation: `${actor}:0`, element: { ...createElement('rect', { id: 'bad' }), x: 'invalid' } } } };
  records.push([
    bad,
    { key: JSON.stringify(['bad', `${actor}:0`, 'x']), val: { stamp: { actor, clock: 2 }, value: 'still invalid' } },
    { key: '["bad", "invalid-field"]', val: { value: null } },
  ]);
  doc.getMap('custom').set('untouched', true);
  const originalClock = Y.decodeStateVector(Y.encodeStateVector(doc));
  store.compact(board.id, Y.encodeStateAsUpdate(doc));
  const offline = new Y.Doc(); Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
  const child = fork(fileURLToPath(new URL('./backup-cli.ts', import.meta.url)), ['prune-element', board.id, 'bad'], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, WHITEBOARD_DATA_DIR: path, WHITEBOARD_SESSION_SECRET: secret },
  });
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let errors = ''; child.stderr!.on('data', bytes => { errors += bytes.toString(); });
  await until(() => child.exitCode !== null || child.signalCode !== null);
  expect(child.exitCode, errors).toBe(0);
  const repaired = new Y.Doc(); Y.applyUpdate(repaired, store.loadDocument(board.id)!);
  const repairedClock = Y.decodeStateVector(Y.encodeStateVector(repaired));
  for (const [clientId, clock] of originalClock) expect(repairedClock.get(clientId)).toBeGreaterThanOrEqual(clock);
  expect(repaired.getMap('custom').get('untouched')).toBe(true);
  expect(repaired.getArray(WRITER_PREFIX + actor).length).toBe(0);
  // This update predates the repair and carries its old base and an offline field.
  offline.getArray(WRITER_PREFIX + actor).push([{ key: JSON.stringify(['bad', `${actor}:0`, 'y']), val: { stamp: { actor, clock: 3 }, value: 5 } }]);
  Y.applyUpdate(repaired, Y.encodeStateAsUpdate(offline));
  const projection = new BoardDocument(repaired);
  expect(projection.readAll().map(element => element.id)).toEqual(['healthy']);
  projection.create('ellipse', { id: 'after-repair' });
  expect(projection.readAll().map(element => element.id)).toEqual(['healthy', 'after-repair']);
  projection.destroy(); model.destroy(); offline.destroy();
});

test('initial sync rejects poison queued while offline', async () => {
  const { app, board, tokens } = await setup();
  const doc = new Y.Doc(), actor = String(doc.clientID);
  doc.getArray(WRITER_PREFIX + actor).push([null]);
  let reset: any;
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: board.id, token: tokens.editor!, document: doc,
    onStateless: ({ payload }) => { reset = JSON.parse(payload); socket.disconnect(); } });
  cleanups.push(() => { provider.destroy(); socket.destroy(); doc.destroy(); }); provider.attach();
  await until(() => !!reset);
  expect(reset.reason).toBe('invalid-document-update');
  expect(app.store.stats(board.id).updateCount).toBe(0);
  expect(app.server.hocuspocus.documents.get(board.id)?.share.has(WRITER_PREFIX + actor) ?? false).toBe(false);
});

test('historical poison allows healthy edits and pruning, but cannot be replaced with new poison', async () => {
  const { app, board, tokens } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!);
  const actor = 'historical-poison', serverDoc = app.server.hocuspocus.documents.get(board.id)!;
  const bad = { key: JSON.stringify(['bad', '$base']), val: { stamp: { actor, clock: 1 }, value: { generation: `${actor}:0`, element: { ...createElement('rect', { id: 'bad' }), x: 'old poison' } } } };
  serverDoc.getArray(WRITER_PREFIX + actor).push([bad]);
  const editor = await client(app.port, board.id, tokens.editor!);
  const model = new BoardDocument(editor.doc); cleanups.push(() => model.destroy());
  let reset: any;
  editor.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); editor.socket.disconnect(); });
  model.create('rect', { id: 'new-healthy' });
  await until(() => !editor.provider.hasUnsyncedChanges);
  expect(reset).toBeUndefined();
  // Replacing a known issue at the same key changes its fingerprint and is rejected.
  const records = editor.doc.getArray(WRITER_PREFIX + actor);
  editor.doc.transact(() => { records.delete(0, 1); records.push([{ ...bad, val: { ...bad.val, value: { ...bad.val.value, element: { ...bad.val.value.element, x: 'new poison' } } } }]); });
  await until(() => !!reset);
  expect(reset.reason).toBe('invalid-document-update');
  const fresh = await client(app.port, board.id, tokens.editor!), repair = new BoardDocument(fresh.doc); cleanups.push(() => repair.destroy());
  repair.delete('bad');
  await until(() => !fresh.provider.hasUnsyncedChanges);
  expect(repair.readAll().map(element => element.id)).toEqual(['new-healthy']);
  expect((serverDoc.getArray<any>(WRITER_PREFIX + actor).get(0).val.value.element as any).x).toBe('old poison');
  expect(owner.doc.getArray(WRITER_PREFIX + actor).length).toBe(1);
});

test('oversized WebSocket updates close before changing the live document or log', async () => {
  const { app, board, tokens } = await setup({ maxUpdateBytes: 1024 });
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  const before = app.store.stats(board.id);
  let closeCode = 0;
  editor.socket.on('close', ({ event }: { event: { code: number } }) => { closeCode = event.code; editor.socket.disconnect(); });
  editor.doc.getMap('limits').set('oversized', 'x'.repeat(2048));
  await until(() => closeCode === 1009, 1000);
  expect(app.store.stats(board.id)).toEqual(before);
  expect(owner.doc.getMap('limits').get('oversized')).toBeUndefined();
  owner.doc.getMap('limits').set('healthy', true);
  await until(() => !owner.provider.hasUnsyncedChanges);
  expect((await fetch(`http://127.0.0.1:${app.port}/ready`)).status).toBe(200);
});

test('board storage refusal happens before apply and sends a recoverable capacity notice', async () => {
  const { app, board, tokens } = await setup({ maxBoardBytes: 2048 });
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  owner.doc.getMap('limits').set('near-capacity', 'x'.repeat(1700));
  await until(() => !owner.provider.hasUnsyncedChanges);
  const before = app.store.stats(board.id); let refusal: any;
  editor.provider.on('stateless', ({ payload }: { payload: string }) => { refusal = JSON.parse(payload); editor.socket.disconnect(); });
  editor.doc.getMap('limits').set('too-much', 'x'.repeat(700));
  await until(() => !!refusal, 1000);
  expect(refusal).toMatchObject({ type: 'board-full', reason: 'board-full', boardId: board.id, retryable: true, maxBytes: 2048 });
  expect(owner.doc.getMap('limits').get('too-much')).toBeUndefined();
  expect(app.store.stats(board.id)).toEqual(before);
  expect((await fetch(`http://127.0.0.1:${app.port}/ready`)).status).toBe(200);
});

test('a compressed forged GC span is rejected before integration and healthy followup remains possible', async () => {
  const { app, board, tokens } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  let reset: any; editor.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); editor.socket.disconnect(); });
  const before = app.store.stats(board.id);
  editor.doc.transact(transaction => { new Y.GC(Y.createID(777, 0), Number.MAX_SAFE_INTEGER - 10).integrate(transaction, 0); });
  await until(() => !!reset, 1000);
  expect(reset.reason).toBe('invalid-document-update');
  expect(Y.decodeStateVector(Y.encodeStateVector(app.server.hocuspocus.documents.get(board.id)!)).has(777)).toBe(false);
  expect(app.store.stats(board.id)).toEqual(before);
  owner.doc.getMap('limits').set('after-attack', true);
  await until(() => !owner.provider.hasUnsyncedChanges);
  expect(owner.doc.getMap('limits').get('after-attack')).toBe(true);
});

test('a socket that never drains drops awareness and is terminated after its grace period', async () => {
  const { app, board, tokens } = await setup({ maxBufferedBytes: 1024, slowSocketGraceMs: 50 });
  const owner = await client(app.port, board.id, tokens.owner!), slow = await client(app.port, board.id, tokens.editor!);
  const connection = app.server.hocuspocus.documents.get(board.id)!.getConnections().find(value => value.context.userId === app.store.authenticate(tokens.editor!)!.user.id)!;
  const socket = connection.webSocket as WebSocket;
  const original = Object.getOwnPropertyDescriptor(socket, 'bufferedAmount');
  Object.defineProperty(socket, 'bufferedAmount', { configurable: true, get: () => 2048 });
  const sent = vi.spyOn(socket, 'send'), terminated = vi.spyOn(socket, 'terminate');
  cleanups.push(() => { sent.mockRestore(); terminated.mockRestore(); if (original) Object.defineProperty(socket, 'bufferedAmount', original); else delete (socket as any).bufferedAmount; });
  slow.socket.on('close', () => slow.socket.disconnect());
  owner.provider.awareness!.setLocalState({ userId: 'owner', name: 'Owner' });
  await until(() => terminated.mock.calls.length === 1, 1000);
  expect(sent).not.toHaveBeenCalled();
  expect(app.server.hocuspocus.documents.get(board.id)!.getConnections().some(value => value === connection)).toBe(false);
});

function syncPacket(boardId: string, update: Uint8Array) {
  const uint = (value: number) => { const bytes: number[] = []; while (value >= 128) { bytes.push((value % 128) | 128); value = Math.floor(value / 128); } bytes.push(value); return bytes; };
  const name = new TextEncoder().encode(boardId);
  return new Uint8Array([...uint(name.length), ...name, 0, 2, ...uint(update.length), ...update]);
}

test('bounded queue overload refuses queued writes without mutating or marking storage unavailable', async () => {
  const { app, board, tokens } = await setup({ maxUpdateBytes: 4096, maxInboundBytes: 4096 });
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  const connection = app.server.hocuspocus.documents.get(board.id)!.getConnections().find(value => value.context.token === tokens.editor)!;
  const before = connection.callbacks.beforeHandleMessage;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(() => release());
  connection.callbacks.beforeHandleMessage = async (...args) => { await gate; await before(...args); };
  let refusal: any; editor.provider.on('stateless', ({ payload }: { payload: string }) => { refusal = JSON.parse(payload); editor.socket.disconnect(); });
  const source = new Y.Doc(); source.getMap('limits').set('queued', 'x'.repeat(2000));
  const packet = syncPacket(board.id, Y.encodeStateAsUpdate(source)); source.destroy();
  const stats = app.store.stats(board.id);
  connection.handleMessage(packet); connection.handleMessage(packet); connection.handleMessage(packet);
  await until(() => !!refusal, 1000); release();
  expect(refusal).toMatchObject({ type: 'sync-rejected', reason: 'inbound-overload', retryable: true, maxBytes: 4096 });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(owner.doc.getMap('limits').get('queued')).toBeUndefined(); expect(app.store.stats(board.id)).toEqual(stats);
  expect((await fetch(`http://127.0.0.1:${app.port}/ready`)).status).toBe(200);
});

test('concurrent updates reserve board capacity before either peer can overshoot it', async () => {
  const { app, board, tokens } = await setup({ maxBoardBytes: 1700 });
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  const refused: any[] = [];
  for (const peer of [owner, editor]) peer.provider.on('stateless', ({ payload }: { payload: string }) => { refused.push(JSON.parse(payload)); peer.socket.disconnect(); });
  owner.doc.getMap('limits').set('left', 'x'.repeat(1000)); editor.doc.getMap('limits').set('right', 'y'.repeat(1000));
  await until(() => refused.length === 1, 1000);
  expect(refused[0].reason).toBe('board-full');
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, app.store.loadDocument(board.id)!);
  expect(Object.keys(persisted.getMap('limits').toJSON())).toHaveLength(1); persisted.destroy();
  const stats = app.store.stats(board.id); expect(stats.snapshotBytes + stats.updateBytes).toBeLessThanOrEqual(1700);
  expect((await fetch(`http://127.0.0.1:${app.port}/ready`)).status).toBe(200);
});

test('an unresolved suffix is never stored and the same offline document converges after full retry', async () => {
  const { app, board, tokens } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  const connection = app.server.hocuspocus.documents.get(board.id)!.getConnections().find(value => value.context.token === tokens.editor)!;
  const source = new Y.Doc(); source.getMap('offline').set('prefix', 1); const vector = Y.encodeStateVector(source);
  source.getMap('offline').set('suffix', 2); const suffix = Y.encodeStateAsUpdate(source, vector), stats = app.store.stats(board.id);
  let refusal: any; editor.provider.on('stateless', ({ payload }: { payload: string }) => { refusal = JSON.parse(payload); editor.socket.disconnect(); });
  connection.handleMessage(syncPacket(board.id, suffix)); await until(() => !!refusal, 1000);
  expect(refusal).toMatchObject({ reason: 'incomplete-update', retryable: true }); expect(app.store.stats(board.id)).toEqual(stats);
  expect(app.server.hocuspocus.documents.get(board.id)!.store.pendingStructs).toBeNull();
  const retried = await client(app.port, board.id, tokens.editor!, source);
  await until(() => !retried.provider.hasUnsyncedChanges && owner.doc.getMap('offline').get('suffix') === 2);
  expect(owner.doc.getMap('offline').toJSON()).toEqual({ prefix: 1, suffix: 2 });
});

test('quota charges only newly emitted changes when an honest offline retry includes historical deletions', async () => {
  const { app, board, tokens } = await setup({ maxBoardBytes: 1024 });
  const history = new Y.Doc(); history.getArray('history').push(Array.from({ length: 40 }, () => 'value'));
  for (let index = 38; index >= 0; index -= 2) history.getArray('history').delete(index, 1);
  app.store.compact(board.id, Y.encodeStateAsUpdate(history)); history.destroy();
  const editor = await client(app.port, board.id, tokens.editor!); editor.doc.off('update', editor.provider.documentUpdateHandler);
  editor.doc.getArray('history').push(['new']);
  const incoming = Y.encodeStateAsUpdate(editor.doc, Y.encodeStateVector(app.server.hocuspocus.documents.get(board.id)!));
  const receiver = new Y.Doc(); Y.applyUpdate(receiver, app.store.loadDocument(board.id)!); let acceptedBytes = 0;
  receiver.on('update', update => { acceptedBytes = update.byteLength; }); Y.applyUpdate(receiver, incoming); receiver.destroy();
  expect(incoming.byteLength).toBeGreaterThan(acceptedBytes);
  const stats = app.store.stats(board.id), fill = 1024 - stats.snapshotBytes - stats.updateBytes - acceptedBytes;
  expect(fill).toBeGreaterThan(0);
  // Storage accounting includes all log rows. Reserve the remaining capacity
  // with a valid already-known packet, leaving exactly the real new delta.
  const empty = new Uint8Array([0, 0]);
  for (let index = 0; index < Math.floor(fill / 2); index++) app.store.appendUpdate(board.id, empty);
  const connection = app.server.hocuspocus.documents.get(board.id)!.getConnections().find(value => value.context.token === tokens.editor)!;
  let refusal: any; editor.provider.on('stateless', ({ payload }: { payload: string }) => { refusal = JSON.parse(payload); editor.socket.disconnect(); });
  connection.handleMessage(syncPacket(board.id, incoming));
  await until(() => app.store.stats(board.id).updateBytes > stats.updateBytes + Math.floor(fill / 2) * 2 || !!refusal, 1000);
  expect(refusal).toBeUndefined();
  expect(app.server.hocuspocus.documents.get(board.id)!.getArray('history').toArray()).toContain('new');
  expect((await fetch(`http://127.0.0.1:${app.port}/ready`)).status).toBe(200);
});

test('storage capacity guards append and compaction atomically even outside the WebSocket server', () => {
  const store = new Store(':memory:', secret, 512); cleanups.push(() => store.close());
  const user = store.createUser('quota-owner', password), board = store.createBoard(user.id, 'Capacity'), before = store.stats(board.id), snapshot = store.loadDocument(board.id)!;
  expect(() => store.appendUpdate(board.id, new Uint8Array(512))).toThrow('Board storage limit');
  expect(() => store.compact(board.id, new Uint8Array(513))).toThrow('Board storage limit');
  expect(store.stats(board.id)).toEqual(before); expect(store.loadDocument(board.id)).toEqual(snapshot);
  const tiny = new Store(':memory:', secret, 1); cleanups.push(() => tiny.close());
  const tinyUser = tiny.createUser('tiny-owner', password); expect(() => tiny.createBoard(tinyUser.id, 'Too big')).toThrow('Board storage limit');
  expect(tiny.boards(tinyUser.id)).toEqual([]);
});

test('snapshot and update-log compaction preserve the original clocks and offline edits', () => {
  const path = directory(), store = new Store(join(path, 'db.sqlite'), secret); cleanups.push(() => store.close());
  const user = store.createUser('compactor', password), board = store.createBoard(user.id, 'History');
  const current = new Y.Doc(), offline = new Y.Doc();
  current.on('update', update => store.appendUpdate(board.id, update));
  current.getMap('state').set('base', 1); Y.applyUpdate(offline, Y.encodeStateAsUpdate(current));
  for (let index = 0; index < 1000; index++) current.getMap('state').set('edited', index);
  offline.getMap('state').set('offline', 'retained');
  const clock = Y.encodeStateVector(current); store.compact(board.id, Y.encodeStateAsUpdate(current));
  expect(store.stats(board.id).updateCount).toBe(0);
  const restored = new Y.Doc(); Y.applyUpdate(restored, store.loadDocument(board.id)!);
  expect(Y.encodeStateVector(restored)).toEqual(clock);
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(offline));
  expect(restored.getMap('state').toJSON()).toEqual({ base: 1, edited: 999, offline: 'retained' });
  [current, offline, restored].forEach(doc => doc.destroy());
});

test('HTTP logout immediately removes passive subscriptions for its exact token and invalidates queued writes', async () => {
  const { app, board, tokens, request } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!), passive = await client(app.port, board.id, tokens.editor!);
  const otherToken = app.store.login('editor', password)!.token, otherSession = await client(app.port, board.id, otherToken);
  owner.doc.getMap('session-test').set('before', 1);
  await until(() => passive.doc.getMap('session-test').get('before') === 1 && otherSession.doc.getMap('session-test').get('before') === 1);
  let reset: any;
  passive.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); passive.socket.disconnect(); });
  expect((await request('/api/session/logout', tokens.editor!, { method: 'POST' })).status).toBe(204);
  await until(() => !!reset);
  expect(reset).toMatchObject({ type: 'permission-changed', role: null, resetRequired: true, reason: 'session-revoked' });
  expect(app.server.hocuspocus.documents.get(board.id)!.getConnections().some(connection => connection.context.token === tokens.editor)).toBe(false);
  owner.doc.getMap('session-test').set('afterLogout', 2);
  await until(() => otherSession.doc.getMap('session-test').get('afterLogout') === 2);
  expect(passive.doc.getMap('session-test').get('afterLogout')).toBeUndefined();
  passive.doc.getMap('session-test').set('queuedAfterLogout', true);
  // A different signed session for the same user remains authorized.
  otherSession.doc.getMap('session-test').set('otherSessionAccepted', true);
  await until(() => owner.doc.getMap('session-test').get('otherSessionAccepted') === true);
  expect((await request('/api/session', tokens.editor!)).status).toBe(401);
  expect((await request('/api/session', otherToken)).status).toBe(200);
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, app.store.loadDocument(board.id)!);
  expect(persisted.getMap('session-test').toJSON()).toEqual({ before: 1, afterLogout: 2, otherSessionAccepted: true }); persisted.destroy();
});

test('a passive authenticated socket is closed at the exact signed session expiry', async () => {
  const { app, board, tokens } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!);
  owner.doc.getMap('expiry-test').set('before', 1);
  const session = app.store.login('editor', password)!, expiresAt = Date.now() + 500;
  app.store.db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(expiresAt, session.sessionId);
  const payload = Buffer.from(JSON.stringify({ sessionId: session.sessionId, userId: session.user.id, expiresAt })).toString('base64url');
  const token = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const passive = await client(app.port, board.id, token); let reset: any, resetAt = 0;
  passive.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); resetAt = Date.now(); passive.socket.disconnect(); });
  expect(passive.doc.getMap('expiry-test').get('before')).toBe(1);
  await until(() => !!reset);
  expect(resetAt).toBeGreaterThanOrEqual(expiresAt);
  expect(reset).toMatchObject({ type: 'permission-changed', role: null, resetRequired: true, reason: 'session-expired' });
  expect(app.store.authenticate(token)).toBeNull();
  expect(app.server.hocuspocus.documents.get(board.id)!.getConnections().some(connection => connection.context.token === token)).toBe(false);
  owner.doc.getMap('expiry-test').set('afterExpiry', 2);
  await until(() => !owner.provider.hasUnsyncedChanges);
  expect(passive.doc.getMap('expiry-test').get('afterExpiry')).toBeUndefined();
});

test('live membership changes notify and reset editors; readonly offline edits cannot silently replay', async () => {
  const { app, board, tokens, request } = await setup();
  const owner = await client(app.port, board.id, tokens.owner!), editor = await client(app.port, board.id, tokens.editor!);
  owner.doc.getMap('state').set('accepted', 1);
  await until(() => editor.doc.getMap('state').get('accepted') === 1);
  const notifications: any[] = [];
  editor.provider.on('stateless', ({ payload }: { payload: string }) => {
    notifications.push(JSON.parse(payload));
    // Same reset contract as the browser: disconnect the dirty replica before
    // constructing a fresh Doc. Re-authentication of the old Doc is insufficient.
    editor.socket.disconnect();
  });
  const changeRole = (role: string) => request(`/api/boards/${board.id}/members`, tokens.owner, { method: 'POST', body: JSON.stringify({ username: 'editor', role }) });
  expect((await changeRole('viewer')).status).toBe(204);
  await until(() => notifications.length === 1);
  expect(notifications[0]).toMatchObject({ type: 'permission-changed', boardId: board.id, role: 'viewer', resetRequired: true });
  editor.doc.getMap('state').set('queuedAfterDowngrade', true);
  expect(owner.doc.getMap('state').get('queuedAfterDowngrade')).toBeUndefined();
  editor.provider.destroy(); editor.socket.destroy();

  // Reconnecting a dirty offline Doc as readonly must receive an explicit reset,
  // rather than appearing synchronized while its changes remain unsent.
  const dirtyDoc = new Y.Doc(); Y.applyUpdate(dirtyDoc, Y.encodeStateAsUpdate(editor.doc));
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
  let scope = '', rejection: any;
  const dirty = new HocuspocusProvider({ websocketProvider: socket, name: board.id, token: tokens.editor!, document: dirtyDoc,
    onAuthenticated: value => { scope = value.scope; }, onStateless: ({ payload }) => { rejection = JSON.parse(payload); socket.disconnect(); } });
  cleanups.push(() => { dirty.destroy(); socket.destroy(); dirtyDoc.destroy(); }); dirty.attach();
  await until(() => !!rejection);
  expect(scope).toBe('readonly'); expect(rejection).toMatchObject({ type: 'permission-changed', role: 'viewer', reason: 'read-only-write-rejected' });
  dirty.destroy(); socket.destroy();
  const freshViewer = await client(app.port, board.id, tokens.editor!);
  expect(freshViewer.provider.authorizedScope).toBe('readonly');
  expect(freshViewer.doc.getMap('state').toJSON()).toEqual({ accepted: 1 });
  freshViewer.provider.destroy(); freshViewer.socket.destroy();
  expect((await changeRole('editor')).status).toBe(204);
  const freshEditor = await client(app.port, board.id, tokens.editor!);
  freshEditor.doc.getMap('state').set('afterRegrant', true);
  await until(() => owner.doc.getMap('state').get('afterRegrant') === true);
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, app.store.loadDocument(board.id)!);
  expect(persisted.getMap('state').toJSON()).toEqual({ accepted: 1, afterRegrant: true }); persisted.destroy();
});

test('real model converges under 1000 concurrent operation pairs and isolates peer changes from undo', async () => {
  const { app, board, tokens } = await setup();
  const leftClient = await client(app.port, board.id, tokens.owner!), rightClient = await client(app.port, board.id, tokens.editor!);
  const left = new BoardDocument(leftClient.doc), right = new BoardDocument(rightClient.doc);
  cleanups.push(() => { left.destroy(); right.destroy(); });
  for (let index = 0; index < 20; index++) left.create('rect', { id: `shape-${index}`, x: index * 20, y: 0 });
  await until(() => right.readAll().length === 20);
  let seed = 0x12345678;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let pair = 0; pair < 1000; pair++) {
    const id = `shape-${random() % 20}`;
    left.move([id], { x: random() % 11 - 5, y: random() % 11 - 5 });
    right.updateStyle([id], { fill: `#${(random() & 0xffffff).toString(16).padStart(6, '0')}` });
    if (pair % 17 === 0) left.undoManager.undo();
    if (pair % 29 === 0) right.undoManager.undo();
    if (pair % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  await until(() => !leftClient.provider.hasUnsyncedChanges && !rightClient.provider.hasUnsyncedChanges);
  const canonical = (doc: BoardDocument) => JSON.stringify(doc.readAll().sort((a, b) => a.id.localeCompare(b.id)));
  await until(() => canonical(left) === canonical(right));
  for (const element of left.readAll()) assertValidElement(element);
  left.move(['shape-0'], { x: 20, y: 0 });
  await until(() => canonical(left) === canonical(right));
  right.updateStyle(['shape-0'], { fill: '#ff5500' });
  await until(() => canonical(left) === canonical(right));
  left.undoManager.undo();
  await until(() => canonical(left) === canonical(right));
  expect(left.read('shape-0')!.style.fill).toBe('#ff5500');
  const restored = new Y.Doc(); Y.applyUpdate(restored, app.store.loadDocument(board.id)!);
  const serverProjection = new BoardDocument(restored, { undo: false });
  expect(canonical(serverProjection)).toBe(canonical(left)); serverProjection.destroy(); restored.destroy();
});

test('a measured 30-second offline interval retains local and remote edits on reconnect', async () => {
  const { app, board, tokens } = await setup();
  const offlineClient = await client(app.port, board.id, tokens.owner!), onlineClient = await client(app.port, board.id, tokens.editor!);
  const offline = new BoardDocument(offlineClient.doc), online = new BoardDocument(onlineClient.doc);
  cleanups.push(() => { offline.destroy(); online.destroy(); });
  offline.create('rect', { id: 'shared', x: 0, y: 0 });
  await until(() => !!online.read('shared'));
  offlineClient.socket.disconnect();
  const start = performance.now();
  offline.move(['shared'], { x: 75, y: 25 });
  offline.create('sticky', { id: 'offline-created', props: { text: 'Saved while offline', align: 'left', autoSize: true } });
  online.updateStyle(['shared'], { fill: '#0055ff' });
  online.create('ellipse', { id: 'online-created' });
  await new Promise(resolve => setTimeout(resolve, 30_000));
  expect(performance.now() - start).toBeGreaterThanOrEqual(30_000);
  await offlineClient.socket.connect();
  await until(() => !offlineClient.provider.hasUnsyncedChanges && offline.readAll().length === 3 && online.readAll().length === 3);
  await until(() => online.read('shared')!.x === 75 && offline.read('shared')!.style.fill === '#0055ff');
  expect(online.read('shared')).toMatchObject({ x: 75, y: 25, style: { fill: '#0055ff' } });
  expect(online.read('offline-created')!.props).toMatchObject({ text: 'Saved while offline' });
});

test('online backup restores accounts, board state and asset bytes into a fresh store', async () => {
  const { app, options, owner, board, tokens, request } = await setup();
  const clientDoc = await client(app.port, board.id, tokens.owner!);
  clientDoc.doc.getMap('test').set('backup', 'recover me');
  await until(() => app.store.stats(board.id).updateCount > 0);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const uploaded = await (await request(`/api/boards/${board.id}/assets`, tokens.owner, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes })).json() as { assetId: string };
  const path = directory(), backup = join(path, 'backup'), restoredDirectory = join(path, 'restored');
  const manifest = await createBackup(app.store, options.assetDirectory, secret, backup); expect(manifest.assets).toBe(1);
  restoreBackup(backup, restoredDirectory);
  const restored = new Store(join(restoredDirectory, 'whiteboard.sqlite'), readFileSync(join(restoredDirectory, 'session-secret'), 'utf8')); cleanups.push(() => restored.close());
  expect(restored.authenticate(tokens.owner!)!.user.id).toBe(owner.id);
  const doc = new Y.Doc(); Y.applyUpdate(doc, restored.loadDocument(board.id)!); expect(doc.getMap('test').get('backup')).toBe('recover me'); doc.destroy();
  const asset = restored.asset(board.id, uploaded.assetId)!; expect(readFileSync(join(restoredDirectory, 'assets', asset.storageKey))).toEqual(bytes);
  expect(() => restoreBackup(backup, restoredDirectory)).toThrow('must not already exist');
  writeFileSync(join(backup, 'assets', asset.storageKey), 'corrupted');
  expect(() => restoreBackup(backup, join(path, 'corrupted'))).toThrow('verification failed');
});

test('router preserves owner mapping, proxies HTTP and WebSockets, and fails closed while draining', async () => {
  const nodes = [{ id: 'a', url: 'http://127.0.0.1:1' }, { id: 'b', url: 'http://127.0.0.1:2' }], added = [...nodes, { id: 'c', url: 'http://127.0.0.1:3' }];
  for (let id = 0; id < 1000; id++) { const before = shardFor(String(id), nodes), after = shardFor(String(id), added); expect(after.id === before.id || after.id === 'c').toBe(true); }
  const { app, board, tokens } = await setup();
  const router = createRouter([{ id: 'local', url: `http://127.0.0.1:${app.port}` }], { port: 0 }); await router.listen(); cleanups.push(() => router.close());
  expect((await fetch(`http://127.0.0.1:${router.port}/ready`)).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${router.port}/api/boards`, { headers: { Authorization: `Bearer ${tokens.owner}` } })).status).toBe(200);
  const absoluteTargetStatus = await new Promise<number>((resolve, reject) => {
    const probe = httpRequest({ host: '127.0.0.1', port: router.port, path: 'http://127.0.0.1:1/api/boards', headers: { Authorization: `Bearer ${tokens.owner}` } }, response => { response.resume(); resolve(response.statusCode!); });
    probe.on('error', reject); probe.end();
  });
  expect(absoluteTargetStatus).toBe(200);
  const routed = await client(router.port, board.id, tokens.owner!);
  routed.doc.getMap('test').set('routed', true); await until(() => app.store.stats(board.id).updateCount > 0);
  app.beginDrain(); await router.refresh();
  expect((await fetch(`http://127.0.0.1:${router.port}/ready`)).status).toBe(503);
  expect((await fetch(`http://127.0.0.1:${router.port}/api/boards`)).status).toBe(503);
  // Existing sockets finish accepted edits while new connections are refused.
  routed.doc.getMap('test').set('lastEdit', 'before close'); await until(() => !routed.provider.hasUnsyncedChanges);
  const doc = new Y.Doc(); Y.applyUpdate(doc, app.store.loadDocument(board.id)!); expect(doc.getMap('test').get('lastEdit')).toBe('before close'); doc.destroy();
});

test('SQLite WAL recovers committed edits after an abrupt server-process exit', async () => {
  const path = directory();
  async function spawn() {
    const child = fork(fileURLToPath(new URL('./recovery-fixture.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, RECOVERY_DATA_DIRECTORY: path } });
    const messages: any[] = []; child.on('message', message => messages.push(message));
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.send({ type: 'stop' }); await until(() => child.exitCode !== null || child.signalCode !== null); } });
    await until(() => messages.some(message => message.type === 'ready'));
    return { child, messages, ready: messages.find(message => message.type === 'ready') };
  }
  const first = await spawn(), author = await client(first.ready.port, first.ready.boardId, first.ready.token);
  for (let index = 0; index < 100; index++) author.doc.getMap('recovery').set(`value-${index}`, index);
  await until(() => !author.provider.hasUnsyncedChanges);
  first.child.send({ type: 'persisted' }); await until(() => first.messages.some(message => message.type === 'persisted'));
  expect(first.messages.find(message => message.type === 'persisted').updateCount).toBeGreaterThanOrEqual(100);
  first.child.kill('SIGKILL'); await until(() => first.child.signalCode === 'SIGKILL');
  author.socket.disconnect();
  const second = await spawn(), recovered = await client(second.ready.port, second.ready.boardId, second.ready.token);
  expect(recovered.doc.getMap('recovery').toJSON()).toEqual(author.doc.getMap('recovery').toJSON());
});

test('sign-in permits forty distinct accounts behind one address while bounding failed attempts', async () => {
  const { app, url } = await setup();
  const login = (username: string, suppliedPassword = password) => fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: suppliedPassword }) });
  for (let index = 0; index < 40; index++) { const username = `nat-user-${index}`; app.store.createUser(username, password); expect((await login(username)).status).toBe(200); }
  for (let index = 0; index < 5; index++) expect((await login('nat-user-0', 'wrong-password')).status).toBe(401);
  expect((await login('nat-user-0', 'wrong-password')).status).toBe(429);
  expect((await login('nat-user-1')).status).toBe(200);
  // Failed-account throttling does not consume expensive password work, and
  // the aggregate limit still bounds traffic across arbitrary account names.
  for (let index = 47; index < 120; index++) expect((await fetch(`${url}/api/session`, { method: 'POST', body: '{}' })).status).toBe(400);
  expect((await login('nat-user-2')).status).toBe(429);
});

test('only owners remove board members, owner membership is protected, and removal closes passive subscriptions', async () => {
  const { app, board, owner, editor, tokens, request } = await setup();
  const ownerClient = await client(app.port, board.id, tokens.owner!);
  const removed = await client(app.port, board.id, tokens.editor!);
  ownerClient.doc.getMap('revocation').set('before', true);
  await until(() => removed.doc.getMap('revocation').get('before') === true);
  let reset: any;
  removed.provider.on('stateless', ({ payload }: { payload: string }) => { reset = JSON.parse(payload); removed.socket.disconnect(); });
  const route = `/api/boards/${board.id}/members/editor`;
  expect((await request(route, tokens.editor, { method: 'DELETE' })).status).toBe(403);
  expect((await request(`/api/boards/${board.id}/members/owner`, tokens.owner, { method: 'DELETE' })).status).toBe(400);
  expect(app.store.role(board.id, owner.id)).toBe('owner');
  expect((await request(route, tokens.owner, { method: 'DELETE' })).status).toBe(204);
  await until(() => !!reset);
  expect(reset).toMatchObject({ type: 'permission-changed', boardId: board.id, role: null, resetRequired: true, reason: 'permissions-changed' });
  expect(app.store.role(board.id, editor.id)).toBeUndefined();
  expect((await request(`/api/boards/${board.id}`, tokens.editor)).status).toBe(404);
  ownerClient.doc.getMap('revocation').set('after', true);
  await until(() => !ownerClient.provider.hasUnsyncedChanges);
  expect(removed.doc.getMap('revocation').get('after')).toBeUndefined();
  expect(app.server.hocuspocus.documents.get(board.id)!.getConnections().some(connection => connection.context.userId === editor.id)).toBe(false);
  const preflight = await request(route, tokens.owner, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'DELETE' } });
  expect(preflight.status).toBe(204); expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
});

test('image uploads reject decompression-bomb headers before storing bytes and return validated dimensions', async () => {
  const { app, board, tokens, request } = await setup();
  const { pngHeader } = await import('../../../tests/image-fixtures');
  const assetsBefore = app.store.db.prepare('SELECT count(*) AS count FROM assets').get();
  for (const [width, height] of [[30000, 30000], [10001, 10000], [16385, 1]]) {
    const response = await request(`/api/boards/${board.id}/assets`, tokens.editor, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from(pngHeader(width!, height!)) });
    expect(response.status).toBe(413);
  }
  expect(app.store.db.prepare('SELECT count(*) AS count FROM assets').get()).toEqual(assetsBefore);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const good = await request(`/api/boards/${board.id}/assets`, tokens.editor, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
  expect(good.status).toBe(201); expect(await good.json()).toMatchObject({ width: 1, height: 1, mimeType: 'image/png' });
});

async function pausedMutation(app: Awaited<ReturnType<typeof setup>>['app'], token: string, path: string, method: string, bytes: Buffer, contentType = 'application/json') {
  let admitted = false;
  const authenticate = app.store.authenticate.bind(app.store);
  const spy = vi.spyOn(app.store, 'authenticate').mockImplementation(supplied => { const result = authenticate(supplied); if (supplied === token && result) admitted = true; return result; });
  let send!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    send = httpRequest({ host: '127.0.0.1', port: app.port, path, method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': bytes.length } }, incoming => {
      let body = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { body += chunk; }); incoming.on('end', () => resolve({ status: incoming.statusCode!, body }));
    }); send.on('error', reject);
  });
  cleanups.push(() => { send.destroy(); spy.mockRestore(); });
  const split = Math.max(1, Math.floor(bytes.length / 2)); send.write(bytes.subarray(0, split));
  await until(() => admitted);
  return { finish: async () => { send.end(bytes.subarray(split)); return response; } };
}

test('an authorized HTTP mutation rechecks its session and membership under the write transaction', async () => {
  const { app, board, tokens, request } = await setup();
  const authenticate = app.store.authenticate.bind(app.store), access = app.store.board.bind(app.store), rename = app.store.rename.bind(app.store);
  const checks: string[] = [];
  const authSpy = vi.spyOn(app.store, 'authenticate').mockImplementation(token => { if (app.store.db.inTransaction) checks.push('session'); return authenticate(token); });
  const accessSpy = vi.spyOn(app.store, 'board').mockImplementation((id, user) => { if (app.store.db.inTransaction) checks.push('membership'); return access(id, user); });
  const renameSpy = vi.spyOn(app.store, 'rename').mockImplementation((id, name) => { expect(app.store.db.inTransaction).toBe(true); expect(checks).toEqual(['session', 'membership']); rename(id, name); });
  cleanups.push(() => { authSpy.mockRestore(); accessSpy.mockRestore(); renameSpy.mockRestore(); });
  const response = await request(`/api/boards/${board.id}`, tokens.editor, { method: 'PATCH', body: JSON.stringify({ title: 'Atomic rename' }) });
  expect(response.status).toBe(200); expect(renameSpy).toHaveBeenCalledOnce();
});

test.each(['rename', 'upload'])('an admitted editor %s request is denied if demoted before its body completes', async operation => {
  const { app, board, editor, tokens } = await setup();
  const bytes = operation === 'rename' ? Buffer.from(JSON.stringify({ title: 'Unauthorized late rename' }))
    : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const pending = await pausedMutation(app, tokens.editor!, `/api/boards/${board.id}${operation === 'upload' ? '/assets' : ''}`, operation === 'rename' ? 'PATCH' : 'POST', bytes, operation === 'upload' ? 'image/png' : 'application/json');
  app.store.setMember(board.id, editor.id, 'viewer');
  expect((await pending.finish()).status).toBe(403);
  expect(app.store.board(board.id, editor.id)!.title).toBe('Private board');
  expect(app.store.db.prepare('SELECT count(*) AS count FROM assets').get()).toEqual({ count: 0 });
});

test('an admitted membership grant is denied if the owner loses ownership while sending its body', async () => {
  const { app, board, owner, stranger, tokens } = await setup();
  const pending = await pausedMutation(app, tokens.owner!, `/api/boards/${board.id}/members`, 'POST', Buffer.from(JSON.stringify({ username: 'stranger', role: 'viewer' })));
  app.store.setMember(board.id, owner.id, 'editor');
  expect((await pending.finish()).status).toBe(403); expect(app.store.role(board.id, stranger.id)).toBeUndefined();
});

test('an admitted board creation is denied if its session is revoked while sending its body', async () => {
  const { app, owner, tokens } = await setup(), before = app.store.boards(owner.id);
  const pending = await pausedMutation(app, tokens.owner!, '/api/boards', 'POST', Buffer.from(JSON.stringify({ title: 'Unauthorized late creation' })));
  app.store.revokeSessions(owner.id);
  expect((await pending.finish()).status).toBe(401); expect(app.store.boards(owner.id)).toEqual(before);
});

test.each(['target-demotion', 'source-removal', 'session-revocation'])('asset copy rechecks both permissions and the session after the body arrives: %s', async change => {
  const { app, options, board, stranger, tokens } = await setup();
  const target = app.store.createBoard(stranger.id, 'Copy target'); app.store.setMember(board.id, stranger.id, 'viewer');
  const storageKey = 'copy-source', bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(options.assetDirectory, storageKey), bytes);
  app.store.addAsset({ id: 'copy-source', boardId: board.id, storageKey, size: bytes.length, mimeType: 'image/png' });
  const pending = await pausedMutation(app, tokens.stranger!, `/api/boards/${target.id}/assets/copy`, 'POST', Buffer.from(JSON.stringify({ sourceBoardId: board.id, assetId: 'copy-source' })));
  if (change === 'target-demotion') app.store.setMember(target.id, stranger.id, 'viewer');
  else if (change === 'source-removal') app.store.removeMember(board.id, stranger.id);
  else app.store.revokeSessions(stranger.id);
  expect((await pending.finish()).status).toBe(change === 'target-demotion' ? 403 : change === 'source-removal' ? 404 : 401);
  expect(app.store.db.prepare('SELECT count(*) AS count FROM assets WHERE board_id=?').get(target.id)).toEqual({ count: 0 });
});
