import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Store } from './store.js';
import { createWhiteboardServer } from './server.js';

vi.mock('yjs', async importOriginal => {
  const actual = await importOriginal<typeof import('yjs')>();
  return { ...actual, snapshot: vi.fn(actual.snapshot) };
});
const secret = 'cache-test-secret-with-at-least-thirty-two-characters', password = 'a-long-cache-test-password';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanups.splice(0).reverse()) await stop(); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'whiteboard-cache-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; }
async function until(check: () => boolean) { const start = performance.now(); while (!check()) { if (performance.now() - start > 3000) throw new Error('Cache test synchronization timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function connected(role: 'viewer' | 'editor' = 'viewer') {
  const path = directory(), app = createWhiteboardServer({ databasePath: join(path, 'board.sqlite'), assetDirectory: join(path, 'assets'), sessionSecret: secret, port: 0 });
  cleanups.push(() => app.close()); await app.listen();
  const owner = app.store.createUser('owner', password), user = app.store.createUser('member', password);
  const board = app.store.createBoard(owner.id, 'Cached board'); app.store.setMember(board.id, user.id, role);
  const session = (await app.store.login(user.username, password))!;
  const doc = new Y.Doc(), socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: board.id, token: session.token, document: doc });
  cleanups.push(() => { provider.destroy(); socket.destroy(); doc.destroy(); }); provider.attach(); await until(() => provider.isSynced);
  const live = app.server.hocuspocus.documents.get(board.id)!;
  const connection = live.getConnections().find(value => value.context.token === session.token)!;
  const name = new TextEncoder().encode(board.id);
  // Hocuspocus document address, Awareness type, one-byte payload, zero states.
  const awarenessPacket = new Uint8Array([name.length, ...name, 1, 1, 0]);
  const packet = () => connection.callbacks.beforeHandleMessage(connection, awarenessPacket);
  const sync = (payload = Y.encodeStateAsUpdate(live), type = 2) => connection.callbacks.beforeSync(connection, { type, payload });
  return { app, board, user, session, live, connection, packet, sync };
}

test('all Store queries reuse constructor-prepared statements with separately bound values', async () => {
  const store = new Store(':memory:', secret); cleanups.push(() => store.close());
  const prepare = vi.spyOn(store.db, 'prepare');
  const owner = store.createUser('owner', password), member = store.createUser('member', password);
  for (let round = 0; round < 2; round++) {
    expect(store.userByName(owner.username)).toEqual(owner);
    const session = (await store.login(owner.username, password))!; expect(store.authenticate(session.token)?.user).toEqual(owner);
    const board = store.createBoard(owner.id, `Board ${round}`); store.rename(board.id, "Title '?; --");
    store.setMember(board.id, member.id, 'editor'); expect(store.role(board.id, member.id)).toBe('editor');
    expect(store.board(board.id, owner.id)?.title).toBe("Title '?; --"); expect(store.boards(owner.id)).toHaveLength(round + 1);
    const doc = new Y.Doc(); Y.applyUpdate(doc, store.loadDocument(board.id)!); doc.getMap('test').set('bound', round);
    const updateCount = store.stats(board.id).updateCount;
    store.appendUpdate(board.id, Y.encodeStateAsUpdate(doc)); expect(store.stats(board.id).updateCount).toBe(updateCount + 1);
    store.assertUpdateFits(board.id, 1); expect(store.needsCompaction(board.id)).toBe(false);
    store.compact(board.id); expect(store.stats(board.id).updateCount).toBe(0); doc.destroy();
    const asset = { id: `asset-${round}`, boardId: board.id, mimeType: 'image/png', size: 1, storageKey: `blob-${round}` };
    store.addAsset(asset); expect(store.asset(board.id, asset.id)).toEqual(asset);
    store.removeMember(board.id, member.id); expect(store.role(board.id, member.id)).toBeUndefined();
    store.logout(session.sessionId); expect(store.authenticate(session.token)).toBeNull(); store.revokeSessions(owner.id);
    store.setPassword(owner.username, password);
  }
  expect(prepare).not.toHaveBeenCalled();
});

test('readonly sync reuses a snapshot until document insertion or deletion changes its version', async () => {
  const { live, sync } = await connected();
  live.getMap('test').set('value', 1); vi.mocked(Y.snapshot).mockClear();
  await sync(); await sync(undefined, 1); await sync(); expect(Y.snapshot).toHaveBeenCalledTimes(1);
  live.getMap('test').delete('value'); await sync(); await sync(); expect(Y.snapshot).toHaveBeenCalledTimes(2);
  live.getMap('test').set('value', 2); await sync(); await sync(); expect(Y.snapshot).toHaveBeenCalledTimes(3);
});

test('a cached readonly snapshot still rejects a new forged update', async () => {
  const { live, sync, connection } = await connected(); await sync();
  const peer = new Y.Doc(); cleanups.push(() => peer.destroy()); Y.applyUpdate(peer, Y.encodeStateAsUpdate(live)); peer.getMap('test').set('forbidden', true);
  await expect(sync(Y.encodeStateAsUpdate(peer))).rejects.toThrow('Read-only changes');
  expect(connection.context.invalidated).toBe(true); expect(live.getMap('test').get('forbidden')).toBeUndefined();
});

test('awareness packets reuse membership but authenticate their session every time', async () => {
  const { app, packet } = await connected();
  const role = vi.spyOn(app.store, 'role'), authenticate = vi.spyOn(app.store, 'authenticate');
  await packet(); await packet(); await packet();
  expect(role).not.toHaveBeenCalled(); expect(authenticate).toHaveBeenCalledTimes(3);
});

test.each(['setMember', 'removeMember'] as const)('local %s invalidates a connection role before its next packet', async mutation => {
  const { app, board, user, packet, connection } = await connected('editor'); await packet();
  if (mutation === 'setMember') app.store.setMember(board.id, user.id, 'viewer'); else app.store.removeMember(board.id, user.id);
  await expect(packet()).rejects.toThrow('membership changed'); expect(connection.context.invalidated).toBe(true);
});

test('another SQLite connection invalidates cached membership before the next packet', async () => {
  const { app, board, user, packet, connection } = await connected('editor'); await packet();
  const other = new Store(app.store.filename, secret); cleanups.push(() => other.close()); other.removeMember(board.id, user.id);
  await expect(packet()).rejects.toThrow('membership changed'); expect(connection.context.invalidated).toBe(true);
});

test('an unrelated external commit refreshes a role once, then caches it again', async () => {
  const { app, board, packet } = await connected('editor'); await packet();
  const other = new Store(app.store.filename, secret); cleanups.push(() => other.close()); other.rename(board.id, 'External title');
  const role = vi.spyOn(app.store, 'role'); await packet(); await packet(); expect(role).toHaveBeenCalledTimes(1);
});

test('cached membership cannot keep a revoked session alive', async () => {
  const { app, session, packet, connection } = await connected('editor'); await packet(); app.store.logout(session.sessionId);
  await expect(packet()).rejects.toThrow('Session ended'); expect(connection.context.invalidated).toBe(true);
});
