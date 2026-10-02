import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BoardConnection } from './collaboration';
import { api } from './api';

const transport = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  socketOptions: {} as Record<string, any>,
  attach: vi.fn(), socketDestroy: vi.fn(),
  unsynced: false,
  fetchUpdates: vi.fn(async () => {}),
  disconnect: vi.fn(), connect: vi.fn(async () => {}), destroy: vi.fn(), clearData: vi.fn(async () => {}), storageDestroy: vi.fn(),
}));
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProviderWebsocket: class {
  constructor(options: Record<string, any>) { transport.socketOptions = options; }
  disconnect = transport.disconnect;
  connect = transport.connect;
  destroy = transport.socketDestroy;
}, HocuspocusProvider: class {
  get hasUnsyncedChanges() { return transport.unsynced; }
  awareness = { setLocalState: vi.fn() };
  constructor(options: Record<string, any>) { transport.options = options; }
  disconnect = transport.disconnect;
  connect = transport.connect;
  destroy = transport.destroy;
  attach = transport.attach;
} }));
vi.mock('y-indexeddb', () => ({ fetchUpdates: transport.fetchUpdates, IndexeddbPersistence: class {
  whenSynced = Promise.resolve();
  destroy = transport.storageDestroy;
  clearData = transport.clearData;
} }));
let cache: Map<string, string>, storage: (event: Partial<StorageEvent>) => void;
let tabCache: Map<string, string>;
const connections: BoardConnection[] = [];
const cacheKey = 'whiteboard:owner-id:board-id:cache-epoch';
const blockKey = 'whiteboard:owner-id:board-id:sync-blocked';
beforeEach(() => {
  cache = new Map();
  tabCache = new Map();
  transport.unsynced = false;
  transport.fetchUpdates.mockImplementation(async () => {});
  vi.stubGlobal('window', { addEventListener: vi.fn((name, callback) => { if (name === 'storage') storage = callback; }), removeEventListener: vi.fn() });
  vi.stubGlobal('location', { href: 'http://localhost:3001/board/board-id', protocol: 'http:' });
  vi.stubGlobal('localStorage', { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => tabCache.get(key) ?? null, setItem: (key: string, value: string) => tabCache.set(key, value), removeItem: (key: string) => tabCache.delete(key) });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(async () => {
  for (const connection of connections.splice(0)) { await connection.destroy(); connection.board.destroy(); }
  vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers();
});
async function open() {
  const callbacks = { onPermissionChange: vi.fn(), onError: vi.fn(), onStatus: vi.fn(), onPresence: vi.fn(), onReadOnly: vi.fn(), onSyncBlocked: vi.fn() };
  const connection = await BoardConnection.open({ id: 'board-id', title: 'Board', role: 'owner', updatedAt: 0 },
    { user: { id: 'owner-id', username: 'owner' }, expiresAt: Date.now() + 120000 }, callbacks);
  connections.push(connection); return { connection, callbacks };
}

test('persistence-failed keeps the same document and IndexedDB cache for provider reconnect', async () => {
  const onPermissionChange = vi.fn(), onError = vi.fn();
  const connection = await BoardConnection.open({ id: 'board-id', title: 'Board', role: 'owner', updatedAt: 0 },
    { user: { id: 'owner-id', username: 'owner' }, expiresAt: Date.now() + 120000 },
    { onPermissionChange, onError, onStatus: vi.fn(), onPresence: vi.fn(), onReadOnly: vi.fn() });
  const doc = connection.board.doc, epoch = cache.get('whiteboard:owner-id:board-id:cache-epoch');
  doc.getMap('retained').set('edit', 'saved locally');
  transport.options.onStateless({ payload: JSON.stringify({ type: 'permission-changed', boardId: 'board-id', reason: 'persistence-failed', resetRequired: true }) });
  expect(onPermissionChange).not.toHaveBeenCalled();
  expect(transport.disconnect).not.toHaveBeenCalled();
  expect(cache.get('whiteboard:owner-id:board-id:cache-epoch')).toBe(epoch);
  expect(connection.board.doc).toBe(doc);
  expect(doc.getMap('retained').get('edit')).toBe('saved locally');
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('saved on this device'));
  vi.useFakeTimers();
  transport.connect.mockClear();
  transport.options.onAuthenticationFailed({ reason: 'persistence-failed' });
  expect(onPermissionChange).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(transport.connect).toHaveBeenCalledOnce();
  expect(cache.get('whiteboard:owner-id:board-id:cache-epoch')).toBe(epoch);
  await connection.destroy();
  expect(transport.clearData).not.toHaveBeenCalled();
  connection.board.destroy(); doc.destroy();
});

test('a cookie-bootstrapped session sends an empty WebSocket authentication token', async () => {
  await open();
  const session = vi.spyOn(api, 'session');
  expect(await transport.options.token()).toBe('');
  expect(session).not.toHaveBeenCalled();
});

test('the cookie-authenticated socket is bound to the account that owns its cached replica', async () => {
  await open();
  expect(new URL(transport.socketOptions.url).searchParams.get('expectedUserId')).toBe('owner-id');
});

test('a still-fresh cached session stops after a different cookie account is detected without discarding its work', async () => {
  vi.useFakeTimers(); const { connection, callbacks } = await open(), doc = connection.board.doc, epoch = cache.get(cacheKey);
  doc.getMap('retained').set('work', 'account A local changes'); transport.connect.mockClear();
  transport.options.onAuthenticationFailed({ reason: 'session-identity-changed' });
  expect(transport.disconnect).toHaveBeenCalledOnce();
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('unauthorized');
  expect(callbacks.onReadOnly).toHaveBeenLastCalledWith(true);
  expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('signed-in account changed'));
  expect(callbacks.onPermissionChange).not.toHaveBeenCalled(); expect(cache.get(cacheKey)).toBe(epoch);
  transport.options.onStatus({ status: 'disconnected' }); transport.options.onSynced({ state: true });
  await vi.advanceTimersByTimeAsync(5000); expect(transport.connect).not.toHaveBeenCalled();
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('unauthorized');
  expect(doc.getMap('retained').get('work')).toBe('account A local changes');
  await connection.destroy(); expect(transport.clearData).not.toHaveBeenCalled();
});

test('near-expiry cookie session verification does not require a JSON bearer token', async () => {
  vi.useFakeTimers(); const { callbacks } = await open();
  vi.advanceTimersByTime(90000);
  const session = vi.spyOn(api, 'session').mockResolvedValue({ user: { id: 'owner-id', username: 'owner' }, expiresAt: Date.now() + 120000 });
  expect(await transport.options.token()).toBe('');
  expect(session).toHaveBeenCalledOnce(); expect(callbacks.onError).not.toHaveBeenCalled();
});

test('a changed cookie account fails authentication instead of silently using the new cookie', async () => {
  vi.useFakeTimers(); const { callbacks } = await open(); vi.advanceTimersByTime(90000);
  vi.spyOn(api, 'session').mockResolvedValue({ user: { id: 'other-id', username: 'other' }, expiresAt: Date.now() + 120000 });
  await expect(transport.options.token()).rejects.toThrow('signed-in account changed');
  expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('signed-in account changed'));
});

test.each([
  ['board-full', 'board-full', true], ['sync-rejected', 'update-too-large', false], ['sync-rejected', 'inbound-overload', true], ['sync-rejected', 'incomplete-update', true],
])('%s %s pauses sync without deleting local work or reconnecting', async (type, reason, retryable) => {
  vi.useFakeTimers();
  const { connection, callbacks } = await open(), doc = connection.board.doc, epoch = cache.get(cacheKey);
  doc.getMap('retained').set('edit', 'unsynced work'); transport.connect.mockClear();
  transport.options.onStateless({ payload: JSON.stringify({ type, boardId: 'board-id', reason, retryable, maxBytes: 42 }) });
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  expect(callbacks.onSyncBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ reason, retryable, maxBytes: 42 }));
  expect(callbacks.onReadOnly).toHaveBeenLastCalledWith(true);
  expect(transport.disconnect).toHaveBeenCalledOnce();
  expect(callbacks.onPermissionChange).not.toHaveBeenCalled();
  expect(cache.get(cacheKey)).toBe(epoch);
  expect(JSON.parse(cache.get(blockKey)!)).toMatchObject({ epoch, reason, retryable });
  transport.options.onStatus({ status: 'disconnected' });
  transport.options.onSynced({ state: true });
  transport.options.onAuthenticated({ scope: 'read-write' });
  transport.options.onAuthenticationFailed({ reason: 'persistence-failed' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(transport.connect).not.toHaveBeenCalled();
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  expect(connection.board.doc).toBe(doc); expect(doc.getMap('retained').get('edit')).toBe('unsynced work');
  await connection.destroy(); expect(transport.clearData).not.toHaveBeenCalled();
});

test('a frame closed with 1009 pauses rather than automatically replaying it', async () => {
  const { callbacks } = await open();
  transport.options.onClose?.({ event: { code: 1009, reason: '' } });
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  expect(callbacks.onSyncBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'update-too-large', retryable: false }));
  expect(transport.disconnect).toHaveBeenCalledOnce();
});

test('reopening a blocked cache never connects until an explicit successful retry', async () => {
  cache.set(cacheKey, 'retained-epoch'); cache.set(blockKey, JSON.stringify({ epoch: 'retained-epoch', reason: 'board-full', retryable: true }));
  const { connection, callbacks } = await open();
  expect(transport.socketOptions.autoConnect).toBe(false);
  expect(transport.connect).not.toHaveBeenCalled();
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  await connection.retrySync();
  expect(transport.connect).toHaveBeenCalledOnce();
  expect(cache.has(blockKey)).toBe(true);
  transport.options.onAuthenticated({ scope: 'read-write' });
  expect(callbacks.onReadOnly).toHaveBeenLastCalledWith(true);
  transport.options.onSynced({ state: true });
  await vi.waitFor(() => expect(callbacks.onStatus).toHaveBeenLastCalledWith('live'));
  expect(callbacks.onReadOnly).toHaveBeenLastCalledWith(false);
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('live');
  expect(callbacks.onSyncBlocked).toHaveBeenLastCalledWith(null);
  expect(cache.has(blockKey)).toBe(false); expect(cache.get(cacheKey)).toBe('retained-epoch');
});

test('other-tab block markers pause this replica, and explicit discard rotates its cache', async () => {
  const { connection, callbacks } = await open(), epoch = cache.get(cacheKey);
  const marker = JSON.stringify({ epoch, reason: 'update-too-large', retryable: false }); cache.set(blockKey, marker);
  storage({ key: blockKey, newValue: marker, oldValue: null });
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  transport.connect.mockClear(); await connection.retrySync(); expect(transport.connect).not.toHaveBeenCalled();
  connection.discardLocalChanges();
  expect(cache.get(cacheKey)).not.toBe(epoch); expect(cache.has(blockKey)).toBe(false);
  expect(callbacks.onPermissionChange).toHaveBeenCalledWith('local-changes-discarded');
  await connection.destroy(); expect(transport.clearData).toHaveBeenCalledOnce();
});

test('retry waits for pending update acknowledgement and a failed attempt remains paused', async () => {
  vi.useFakeTimers();
  const { connection, callbacks } = await open();
  transport.options.onStateless({ payload: JSON.stringify({ type: 'board-full', boardId: 'board-id', reason: 'board-full', retryable: true }) });
  await connection.retrySync();
  transport.unsynced = true;
  transport.options.onSynced({ state: true });
  expect(cache.has(blockKey)).toBe(true);
  expect(callbacks.onReadOnly).toHaveBeenLastCalledWith(true);
  transport.unsynced = false;
  transport.options.onUnsyncedChanges({ number: 0 });
  await vi.waitFor(() => expect(cache.has(blockKey)).toBe(false));
  expect(cache.has(blockKey)).toBe(false);
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('live');
  transport.options.onStateless({ payload: JSON.stringify({ type: 'sync-rejected', boardId: 'board-id', reason: 'inbound-overload', retryable: true }) });
  transport.connect.mockClear(); await connection.retrySync();
  transport.options.onClose({ event: { code: 1006, reason: '' } });
  await vi.advanceTimersByTimeAsync(5000);
  expect(transport.connect).toHaveBeenCalledOnce();
  expect(cache.has(blockKey)).toBe(true);
  expect(callbacks.onSyncBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'inbound-overload', retrying: false }));
});

test('normal disconnections and unrelated messages preserve reconnect and permission behavior', async () => {
  const { callbacks } = await open(), epoch = cache.get(cacheKey);
  transport.options.onClose?.({ event: { code: 1006, reason: '' } });
  transport.options.onStatus({ status: 'disconnected' });
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('offline'); expect(transport.disconnect).not.toHaveBeenCalled();
  transport.options.onStateless({ payload: JSON.stringify({ type: 'board-full', boardId: 'another-board', reason: 'board-full', retryable: true }) });
  expect(callbacks.onSyncBlocked).not.toHaveBeenCalled(); expect(cache.get(cacheKey)).toBe(epoch);
  transport.options.onStateless({ payload: JSON.stringify({ type: 'permission-changed', boardId: 'board-id', reason: 'permissions-changed', resetRequired: true }) });
  expect(callbacks.onPermissionChange).toHaveBeenCalled(); expect(cache.get(cacheKey)).not.toBe(epoch);
});

test('a successful retry cannot erase a newer refusal from another tab', async () => {
  const { connection, callbacks } = await open();
  transport.options.onStateless({ payload: JSON.stringify({ type: 'board-full', boardId: 'board-id', reason: 'board-full', retryable: true }) });
  await connection.retrySync();
  const newer = JSON.stringify({ epoch: cache.get(cacheKey), revision: 'another-tab', reason: 'update-too-large', retryable: false });
  cache.set(blockKey, newer);
  transport.options.onSynced({ state: true });
  await vi.waitFor(() => expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited'));
  expect(cache.get(blockKey)).toBe(newer);
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  expect(callbacks.onSyncBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'update-too-large' }));
});

test('a sibling stays paused through reload when another tab clears the shared marker', async () => {
  const { connection, callbacks } = await open();
  transport.options.onStateless({ payload: JSON.stringify({ type: 'sync-rejected', boardId: 'board-id', reason: 'update-too-large', retryable: false }) });
  const previous = cache.get(blockKey); cache.delete(blockKey);
  storage({ key: blockKey, oldValue: previous, newValue: null });
  expect(callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  expect(callbacks.onSyncBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'update-too-large' }));
  await connection.destroy(); transport.connect.mockClear();
  const reopened = await open();
  expect(transport.connect).not.toHaveBeenCalled();
  expect(reopened.callbacks.onStatus).toHaveBeenLastCalledWith('limited');
  expect(reopened.callbacks.onSyncBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'update-too-large' }));
});

test('a manual retry includes shared persisted changes and cannot clear before their acknowledgement', async () => {
  const { connection, callbacks } = await open();
  transport.options.onStateless({ payload: JSON.stringify({ type: 'board-full', boardId: 'board-id', reason: 'board-full', retryable: true }) });
  transport.fetchUpdates.mockClear(); transport.connect.mockClear();
  let release!: () => void;
  transport.fetchUpdates.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const retry = connection.retrySync();
  expect(transport.fetchUpdates).toHaveBeenCalledOnce(); expect(transport.connect).not.toHaveBeenCalled();
  release(); await retry; expect(transport.connect).toHaveBeenCalledOnce();
  // The public fetchUpdates API applies the current IndexedDB replica to this
  // actual Y.Doc. Model a sibling update discovered by the final cache read.
  transport.fetchUpdates.mockImplementationOnce(async () => {
    connection.board.doc.getMap('shared-cache').set('sibling-change', 'retained'); transport.unsynced = true;
  });
  transport.options.onSynced({ state: true });
  await vi.waitFor(() => expect(connection.board.doc.getMap('shared-cache').get('sibling-change')).toBe('retained'));
  expect(cache.has(blockKey)).toBe(true); expect(tabCache.has(blockKey)).toBe(true);
  expect(callbacks.onReadOnly).toHaveBeenLastCalledWith(true);
  transport.unsynced = false; transport.options.onUnsyncedChanges({ number: 0 });
  await vi.waitFor(() => expect(callbacks.onStatus).toHaveBeenLastCalledWith('live'));
  expect(cache.has(blockKey)).toBe(false); expect(tabCache.has(blockKey)).toBe(false);
  // A new tab can now safely use the acknowledged shared cache.
  await connection.destroy(); transport.connect.mockClear(); await open();
  expect(transport.connect).toHaveBeenCalledOnce();
});
