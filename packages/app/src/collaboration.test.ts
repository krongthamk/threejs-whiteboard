import { afterEach, expect, test, vi } from 'vitest';
import { BoardConnection } from './collaboration';

const transport = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  disconnect: vi.fn(), connect: vi.fn(async () => {}), destroy: vi.fn(), clearData: vi.fn(), storageDestroy: vi.fn(),
}));
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: class {
  awareness = { setLocalState: vi.fn() };
  constructor(options: Record<string, any>) { transport.options = options; }
  disconnect = transport.disconnect;
  connect = transport.connect;
  destroy = transport.destroy;
} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {
  whenSynced = Promise.resolve();
  destroy = transport.storageDestroy;
  clearData = transport.clearData;
} }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

test('persistence-failed keeps the same document and IndexedDB cache for provider reconnect', async () => {
  const cache = new Map<string, string>();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('location', { href: 'http://localhost:3001/board/board-id', protocol: 'http:' });
  vi.stubGlobal('localStorage', { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const onPermissionChange = vi.fn(), onError = vi.fn();
  const connection = await BoardConnection.open({ id: 'board-id', title: 'Board', role: 'owner', updatedAt: 0 },
    { user: { id: 'owner-id', username: 'owner' }, token: 'token', expiresAt: Date.now() + 60000 },
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
  transport.options.onAuthenticationFailed({ reason: 'persistence-failed' });
  expect(onPermissionChange).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(transport.connect).toHaveBeenCalledOnce();
  expect(cache.get('whiteboard:owner-id:board-id:cache-epoch')).toBe(epoch);
  await connection.destroy();
  expect(transport.clearData).not.toHaveBeenCalled();
  connection.board.destroy(); doc.destroy();
});
