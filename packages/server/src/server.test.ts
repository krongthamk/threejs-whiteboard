import { afterEach, expect, test } from 'vitest';
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
import { BoardDocument, assertValidElement } from '../../model/src/index.js';
import { createBackup, restoreBackup } from './operations.js';
import { createRouter, shardFor } from './router.js';

const secret = 'test-secret-with-at-least-thirty-two-characters';
const password = 'a-long-test-password';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'whiteboard-server-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; }
async function setup() {
  const path = directory(), options = { databasePath: join(path, 'board.sqlite'), assetDirectory: join(path, 'assets'), sessionSecret: secret, port: 0 };
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
async function client(port: number, board: string, token: string, doc = new Y.Doc()) {
  let authenticationFailure = '';
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collaboration`, WebSocketPolyfill: WebSocket });
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
  const session = await signedIn.json() as { token: string; user: { username: string }; expiresAt: number };
  expect(session.user.username).toBe('owner'); expect(session.expiresAt).toBeGreaterThan(Date.now());
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
  expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await fetch(`${url}/api/boards`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Missing origin' }) })).status).toBe(403);
  expect((await fetch(`${url}/api/boards`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:4173', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Cookie board' }) })).status).toBe(201);
  expect((await request('/api/session', `${session.token}tampered`)).status).toBe(401);
  expect((await request('/api/session/logout', session.token, { method: 'POST' })).status).toBe(204);
  expect((await request('/api/session', session.token)).status).toBe(401);
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
  owner.doc.getMap('test').set('position', 123);
  await until(() => viewer.doc.getMap('test').get('position') === 123 && app.store.stats(board.id).updateCount > 0);
  viewer.doc.getMap('test').set('forbidden', true);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(owner.doc.getMap('test').get('forbidden')).toBeUndefined();
  const session = app.store.authenticate(tokens.owner!)!; app.store.logout(session.sessionId);
  owner.doc.getMap('test').set('afterRevoke', true);
  await new Promise(resolve => setTimeout(resolve, 100));
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, app.store.loadDocument(board.id)!);
  expect(persisted.getMap('test').toJSON()).toEqual({ position: 123 }); persisted.destroy();
  owner.provider.destroy(); owner.socket.destroy(); viewer.provider.destroy(); viewer.socket.destroy();
  await app.close();
  const restarted = createWhiteboardServer(options); await restarted.listen(); cleanups.push(() => restarted.close());
  const recovered = await client(restarted.port, board.id, tokens.editor!);
  expect(recovered.doc.getMap('test').toJSON()).toEqual({ position: 123 });
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
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
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
