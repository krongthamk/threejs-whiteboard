import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Store } from './store.js';
import { createWhiteboardServer } from './server.js';
import { createBackup, restoreBackup } from './operations.js';

const secret = 'title-test-secret-with-at-least-thirty-two-characters', password = 'a-long-title-test-password';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanups.splice(0).reverse()) await stop(); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'whiteboard-title-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; }
async function until(check: () => boolean) { const start = performance.now(); while (!check()) { if (performance.now() - start > 3000) throw new Error('Title synchronization timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function fixture() {
  const path = directory(), app = createWhiteboardServer({ databasePath: join(path, 'board.sqlite'), assetDirectory: join(path, 'assets'), sessionSecret: secret, port: 0 });
  cleanups.push(() => app.close()); await app.listen();
  const owner = app.store.createUser('owner', password), viewer = app.store.createUser('viewer', password);
  const board = app.store.createBoard(owner.id, 'Original title'); app.store.setMember(board.id, viewer.id, 'viewer');
  const ownerSession = (await app.store.login(owner.username, password))!, viewerSession = (await app.store.login(viewer.username, password))!;
  const rename = (title: string) => fetch(`http://127.0.0.1:${app.port}/api/boards/${board.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${ownerSession.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  async function connect(token: string) {
    const doc = new Y.Doc(), socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: board.id, token, document: doc });
    cleanups.push(() => { provider.destroy(); socket.destroy(); doc.destroy(); }); provider.attach(); await until(() => provider.isSynced);
    return { doc, provider, socket };
  }
  return { app, board, owner, path, ownerSession, viewerSession, rename, connect };
}

test('Store rename persists matching SQL and Yjs titles in one update', () => {
  const store = new Store(':memory:', secret); cleanups.push(() => store.close());
  const owner = store.createUser('owner', password), board = store.createBoard(owner.id, 'Original title');
  store.rename(board.id, 'New title');
  const reopened = new Y.Doc(); cleanups.push(() => reopened.destroy()); Y.applyUpdate(reopened, store.loadDocument(board.id)!);
  expect(store.board(board.id, owner.id)?.title).toBe('New title'); expect(reopened.getMap('meta').get('title')).toBe('New title');
  expect(store.stats(board.id).updateCount).toBe(1);
});

test('HTTP rename reaches live viewers and reconnects without persisting its broadcast twice', async () => {
  const { app, board, owner, ownerSession, viewerSession, rename, connect } = await fixture();
  const author = await connect(ownerSession.token), observer = await connect(viewerSession.token);
  const before = app.store.stats(board.id).updateCount;
  expect((await rename('Live title')).status).toBe(200);
  await until(() => author.doc.getMap('meta').get('title') === 'Live title' && observer.doc.getMap('meta').get('title') === 'Live title');
  expect(app.store.stats(board.id).updateCount).toBe(before + 1);
  observer.socket.disconnect(); await until(() => observer.socket.status === 'disconnected');
  expect((await rename('Offline title')).status).toBe(200);
  observer.socket.connect(); await until(() => observer.doc.getMap('meta').get('title') === 'Offline title');
  expect(app.store.board(board.id, owner.id)?.title).toBe('Offline title'); expect(app.store.stats(board.id).updateCount).toBe(before + 2);
});

test.each(['append', 'SQL projection'])('rename %s failure changes neither SQL nor the live Yjs title', async failure => {
  const { app, board, owner, ownerSession, rename, connect } = await fixture(); const author = await connect(ownerSession.token);
  const before = app.store.stats(board.id);
  if (failure === 'append') vi.spyOn(app.store, 'appendUpdate').mockImplementation(() => { throw new Error('Controlled title persistence failure'); });
  else app.store.db.exec("CREATE TRIGGER refuse_title BEFORE UPDATE OF title ON boards BEGIN SELECT RAISE(ABORT, 'Controlled title SQL failure'); END");
  expect((await rename('Must not commit')).status).toBe(500);
  expect(app.store.board(board.id, owner.id)?.title).toBe('Original title'); expect(author.doc.getMap('meta').get('title')).toBe('Original title');
  expect(app.store.stats(board.id)).toEqual(before);
});

test('backup and restored SQLite files have private mode 0600', async () => {
  const { app, path } = await fixture(), backup = join(path, 'backup'), restored = join(path, 'restore');
  await createBackup(app.store, join(path, 'assets'), secret, backup); restoreBackup(backup, restored);
  expect(statSync(join(backup, 'whiteboard.sqlite')).mode & 0o777).toBe(0o600);
  expect(statSync(join(restored, 'whiteboard.sqlite')).mode & 0o777).toBe(0o600);
});
