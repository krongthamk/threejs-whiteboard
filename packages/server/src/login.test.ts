import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store';

const secret = 'login-test-secret-with-at-least-thirty-two-characters';
const password = 'a-long-login-test-password';
const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function database() { const store = new Store(':memory:', secret); stores.push(store); return store; }

test.each(['known', 'unknown', 'wrong', 'malformed', 'null'])('%s credentials use asynchronous password work without blocking the event loop', async kind => {
  const store = database(), user = store.createUser('alice', password);
  if (kind === 'malformed') store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('not-a-password-hash', user.id);
  if (kind === 'null') {
    // Model a legacy/corrupt row without weakening the production NOT NULL schema.
    const sql = 'SELECT * FROM users WHERE username=?', statement = store.db.prepare(sql), prepare = store.db.prepare.bind(store.db);
    vi.spyOn(statement, 'get').mockReturnValue({ ...user, password_hash: null });
    vi.spyOn(store.db, 'prepare').mockImplementation(query => query === sql ? statement : prepare(query));
  }
  let progressed = false;
  const tick = new Promise<void>(resolve => setImmediate(() => { progressed = true; resolve(); }));
  try {
    const session = await store.login(kind === 'unknown' ? 'missing' : 'alice', kind === 'wrong' ? 'wrong-password' : password);
    expect(progressed).toBe(true);
    if (kind === 'known') expect(session?.user.id).toBe(user.id); else expect(session).toBeNull();
  } finally { await tick; }
});

test('a password reset during verification cannot issue a session for the old password', async () => {
  const store = database(); store.createUser('alice', password);
  const pending = store.login('alice', password);
  store.setPassword('alice', 'replacement-login-password');
  expect(await pending).toBeNull();
  expect(store.db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  expect(await store.login('alice', 'replacement-login-password')).not.toBeNull();
});
