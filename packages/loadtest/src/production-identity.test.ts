import { afterEach, expect, test, vi } from 'vitest';
import { productionIdentity } from './production-identity';

afterEach(() => vi.unstubAllGlobals());
test('production awareness uses the authenticated session identity rather than synthetic client labels', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ user: { id: 'authenticated-uuid', username: 'load-owner' }, expiresAt: 123 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await productionIdentity('http://127.0.0.1:12347', 'signed-session')).toEqual({ userId: 'authenticated-uuid', name: 'load-owner' });
  expect(fetcher).toHaveBeenCalledWith(new URL('http://127.0.0.1:12347/api/session'), { headers: { Authorization: 'Bearer signed-session' } });
});
test('production awareness uses a server-supplied display name when present', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ user: { id: 'authenticated-uuid', username: 'load-owner', name: 'Server display name' } })));
  expect(await productionIdentity('http://127.0.0.1:12347', 'signed-session')).toEqual({ userId: 'authenticated-uuid', name: 'Server display name' });
});
test.each([
  [401, { error: 'Sign in to continue' }], [200, {}], [200, { user: { id: '', username: 'load-owner' } }],
  [200, { user: { id: 'authenticated-uuid', username: 'load-owner', name: 123 } }],
])('invalid production session metadata fails before publishing presence (%s)', async (status, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
  await expect(productionIdentity('http://127.0.0.1:12347', 'signed-session')).rejects.toThrow(/Production session/);
});
