import { afterEach, expect, test, vi } from 'vitest';
import { Store } from './store';
import Sqlite from 'better-sqlite3';

const secret = 'login-test-secret-with-at-least-thirty-two-characters';
const password = 'a-long-login-test-password';
const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function database() { const store = new Store(':memory:', secret); stores.push(store); return store; }

test.each(['known', 'unknown', 'wrong', 'malformed', 'null'])('%s credentials use asynchronous password work without blocking the event loop', async kind => {
  let loginStatement: Sqlite.Statement | undefined;
  if (kind === 'null') {
    const prepare = Sqlite.prototype.prepare;
    vi.spyOn(Sqlite.prototype, 'prepare').mockImplementation(function (this: Sqlite.Database, query: string) {
      const statement = prepare.call(this, query);
      if (query === 'SELECT * FROM users WHERE username=?') loginStatement = statement;
      return statement;
    });
  }
  const store = database(), user = store.createUser('alice', password);
  if (kind === 'malformed') store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('not-a-password-hash', user.id);
  if (kind === 'null') {
    // Model a legacy/corrupt row without weakening the production NOT NULL schema.
    vi.spyOn(loginStatement!, 'get').mockReturnValue({ ...user, password_hash: null });
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
