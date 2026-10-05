import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store';
const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });
function fixture() { const store = new Store(':memory:', 'oauth-state-secret-with-at-least-thirty-two-characters'); stores.push(store); const record = { state: 's'.repeat(43), nonce: 'n'.repeat(43), verifier: 'v'.repeat(43), returnPath: '/board/test?tab=1#content', expiresAt: Date.now() + 600000, browserBindingHash: 'a'.repeat(64) }; store.createOAuthState(record); return { store, record }; }
test('a wrong browser cannot consume another browser state; matching callback is single use', () => {
  const { store, record } = fixture(); expect(store.consumeOAuthState(record.state, 'b'.repeat(64))).toBeNull();
  expect(store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 1 });
  expect(store.consumeOAuthState(record.state, record.browserBindingHash)).toEqual(record);
  expect(store.consumeOAuthState(record.state, record.browserBindingHash)).toBeNull();
});
test('matching expiry is consumed, but wrong browser cannot burn even an expired state', () => {
  const { store, record } = fixture(); const now = record.expiresAt;
  expect(store.consumeOAuthState(record.state, 'b'.repeat(64), now)).toBeNull(); expect(store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 1 });
  expect(store.consumeOAuthState(record.state, record.browserBindingHash, now)).toBeNull(); expect(store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
});
test('invalid state fields refuse without storing secrets or replacing a pending row', () => {
  const { store, record } = fixture();
  for (const patch of [{ returnPath: '//evil.example' }, { returnPath: '/\\evil' }, { returnPath: '/ok\n' }, { returnPath: '/\ud800' }, { state: 'bad' }, { browserBindingHash: 'cookie-not-hashed' }, { nonce: 'bad' }, { verifier: 'bad' }, { expiresAt: NaN }, { expiresAt: Date.now() + 601000 }]) expect(() => store.createOAuthState({ ...record, ...patch, state: 't'.repeat(43), ...(patch.state ? { state: patch.state } : {}) })).toThrow(/OAuth/i);
  expect(() => store.createOAuthState({ ...record, nonce: 'x'.repeat(43) })).toThrow(); expect(store.consumeOAuthState(record.state, record.browserBindingHash)).toEqual(record);
});
test('new starts prune only expired states and preserve active browser bindings; failed insert rolls cleanup back', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000000);
  const { store, record } = fixture();
  const live = { ...record, state: 'l'.repeat(43) }; store.createOAuthState(live);
  vi.setSystemTime(record.expiresAt - 1);
  const longer = { ...record, state: 'z'.repeat(43), expiresAt: Date.now() + 600000, browserBindingHash: 'b'.repeat(64) }; store.createOAuthState(longer);
  vi.setSystemTime(record.expiresAt);
  expect(() => store.createOAuthState({ ...longer, expiresAt: Date.now() + 600000 })).toThrow();
  expect(store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 3 });
  store.createOAuthState({ ...record, state: 'f'.repeat(43), expiresAt: Date.now() + 600000 });
  expect(store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 2 });
  expect(store.consumeOAuthState(longer.state, record.browserBindingHash)).toBeNull();
  expect(store.consumeOAuthState(longer.state, longer.browserBindingHash)).toEqual(longer);
});
