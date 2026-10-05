import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { displayName, normalizeExternalEmail } from './identity';

const stores: Store[] = [], secret = 'store-identity-secret-with-more-than-32-characters', password = 'operator-password-at-least-twelve';
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function database() { const store = new Store(':memory:', secret); stores.push(store); return store; }
const rows = (store: Store) => ['users', 'identities', 'sessions'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('canonical external emails accept plus and long bounds without changing aliases or legacy password lookup', async () => {
  expect(normalizeExternalEmail('A.B+Tag@EXAMPLE.COM')).toBe('a.b+tag@example.com');
  const email = 'x'.repeat(64) + '@' + 'd'.repeat(63) + '.' + 'e'.repeat(63) + '.' + 'f'.repeat(61); expect(email).toHaveLength(254); expect(normalizeExternalEmail(email)).toBe(email);
  const store = database(), user = store.createUser('Case@Example.com', password);
  expect(await store.login('case@example.com', password)).toBeNull(); expect((await store.login('Case@Example.com', password))?.user.id).toBe(user.id);
  const long = store.createExternalUser(email); expect(long.username).toBe(email); expect(long.name.length).toBe(80); expect(await store.login(email, password)).toBeNull();
});
test.each([' a@example.com', 'a@example.com\n', 'a..b@example.com', '.a@example.com', 'a@-host.com', 'a@host-.com', 'a@@example.com', 'a@exa_mple.com', '日@example.com', 'a'.repeat(65) + '@example.com'])('invalid external email refuses without exposing raw input: %j', value => {
  let error: unknown; try { normalizeExternalEmail(value); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('Invalid external email');
});
test('display names preserve graphemes and source spelling within the wire bound, including fallback', () => {
  expect(displayName('e\u0301'.repeat(50), 'fallback')).toBe('e\u0301'.repeat(40));
  expect(displayName('👩🏽‍💻'.repeat(20), 'fallback')).toBe('👩🏽‍💻'.repeat(11));
  expect(displayName('', 'long'.repeat(40))).toHaveLength(80); expect(displayName('e' + '\u0301'.repeat(81), 'fallback')).toBe('fallback');
  expect(() => displayName('\ud800', 'fallback')).toThrow('display name'); expect(() => displayName('line\nname', 'fallback')).toThrow('display name');
  expect(() => displayName('Review\u0085Name', 'fallback')).toThrow('display name'); expect(() => displayName('Name\u009f', 'fallback')).toThrow('display name');
  expect(() => displayName('\n', 'fallback')).toThrow('display name'); expect(() => displayName('\t', 'fallback')).toThrow('display name');
  expect(displayName('ไทย 👩🏽‍💻 e\u0301', 'fallback')).toBe('ไทย 👩🏽‍💻 e\u0301');
});
test('verified identity links a unique canonical password candidate without changing its hash, username or memberships', async () => {
  const store = database(), user = store.createUser('Alice@Example.com', password), board = store.createBoard(user.id, 'Existing');
  const hash = store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
  const profile = store.resolveExternalIdentity({ provider: 'google', subject: 'subject-1', email: 'ALICE@example.COM', displayName: 'Alice 日本語' });
  expect(profile).toMatchObject({ id: user.id, username: 'Alice@Example.com', name: 'Alice 日本語', avatarUrl: null });
  expect(store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)).toEqual(hash); expect(store.role(board.id, user.id)).toBe('owner');
  const publicProfile = { id: profile.id, username: profile.username, name: profile.name, avatarUrl: profile.avatarUrl };
  const session = await store.login('Alice@Example.com', password); expect(session?.user).toEqual(publicProfile); expect(store.authenticate(session!.token)?.user).toEqual(publicProfile);
  expect(JSON.stringify(session!.user)).not.toMatch(/fingerprint|password|token|subject|provider/);
});
test('stable subject wins over changed email and cannot be reassigned or claimed by a new subject', () => {
  const store = database(), first = store.resolveExternalIdentity({ provider: 'google', subject: 'stable', email: 'first@example.com', displayName: 'First' }), other = store.createExternalUser('second@example.com');
  const updated = store.resolveExternalIdentity({ provider: 'google', subject: 'stable', email: 'second@example.com', displayName: 'Updated' });
  expect(updated).toMatchObject({ id: first.id, username: 'first@example.com', name: 'Updated' });
  expect(store.userByIdentity('google', 'stable')?.id).toBe(first.id);
  const before = rows(store);
  expect(() => store.linkIdentity({ provider: 'google', subject: 'stable', userId: other.id, email: 'second@example.com' })).toThrow(/identity/i);
  expect(() => store.resolveExternalIdentity({ provider: 'google', subject: 'replacement', email: 'first@example.com', displayName: 'Takeover' })).toThrow(/identity/i);
  expect(rows(store)).toEqual(before);
});
test('case-fold ambiguous legacy users refuse linking with zero mutation', () => {
  const store = database(); store.createUser('Alice@example.com', password); store.createUser('alice@example.com', password); const before = rows(store);
  expect(() => store.resolveExternalIdentity({ provider: 'google', subject: 's', email: 'ALICE@example.com', displayName: 'No' })).toThrow(/ambiguous/i);
  expect(() => store.createExternalUser('alice@example.com')).toThrow(/ambiguous/i); expect(rows(store)).toEqual(before);
});
test('external provisioning reuses the unique account and repeated resolutions converge to one subject and user', () => {
  const store = database(), provisioned = store.createExternalUser('Pre+User@Example.com', 'Provisioned');
  expect(store.createExternalUser('pre+user@example.com').id).toBe(provisioned.id);
  const input = { provider: 'google', subject: 'first-signin', email: 'PRE+USER@example.com', displayName: 'Actual' };
  expect(store.resolveExternalIdentity(input).id).toBe(provisioned.id); expect(store.resolveExternalIdentity(input).id).toBe(provisioned.id);
  expect(store.db.prepare('SELECT count(*) AS n FROM identities').get()).toEqual({ n: 1 }); expect(store.db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
});
test('a failed identity insert rolls back account creation and profile refresh', () => {
  const store = database(); store.db.exec("CREATE TRIGGER reject_identity BEFORE INSERT ON identities BEGIN SELECT RAISE(ABORT,'forced identity failure'); END"); const before = rows(store);
  expect(() => store.resolveExternalIdentity({ provider: 'google', subject: 's', email: 'new@example.com', displayName: 'New' })).toThrow('forced identity failure'); expect(rows(store)).toEqual(before);
});
test('session extraction preserves NULL rejection and fresh profile reads; avatar URLs use monotonic private local revisions', async () => {
  const store = database(), user = store.createExternalUser('avatar@example.com', 'Avatar');
  expect(await store.login(user.username, password)).toBeNull(); const session = store.createSession(user.id); expect(store.authenticate(session.token)?.user).toMatchObject({ name: 'Avatar', avatarUrl: null });
  const first = store.setAvatar(user.id, { storageKey: randomUUID(), urlFingerprint: 'a'.repeat(64), updatedAt: 123 });
  const second = store.setAvatar(user.id, { storageKey: randomUUID(), urlFingerprint: 'b'.repeat(64), updatedAt: 123 });
  expect(second.avatarUpdatedAt).toBe(124); expect(first.avatarUrl).not.toBe(second.avatarUrl); expect(second.avatarUrl).toBe(`/api/users/${user.id}/avatar?v=124`);
  expect(store.authenticate(session.token)?.user.avatarUrl).toBe(second.avatarUrl);
  expect(JSON.stringify(store.createSession(user.id).user)).not.toMatch(/fingerprint|avatarKey|urlFingerprint/);
  const before = rows(store);
  expect(() => store.setAvatar(user.id, { storageKey: '../secret', urlFingerprint: 'b'.repeat(64), updatedAt: 123 })).toThrow(/avatar/i);
  expect(() => store.setAvatar(user.id, { storageKey: randomUUID(), urlFingerprint: 'https://provider/picture', updatedAt: 123 })).toThrow(/avatar/i);
  expect(() => store.setAvatar('missing', { storageKey: randomUUID(), urlFingerprint: 'b'.repeat(64), updatedAt: 123 })).toThrow(/user/i);
  expect(() => store.createSession('missing')).toThrow(/user/i); expect(rows(store)).toEqual(before);
});

test('avatar storage keys canonicalize UUID case before persistence to match generated immutable blob leaves', () => {
  const store = database(), user = store.createExternalUser('case-avatar@example.com');
  const key = 'abcdefab-1234-4234-8234-abcdefabcdef';
  const avatar = store.setAvatar(user.id, { storageKey: key.toUpperCase(), urlFingerprint: 'a'.repeat(64), updatedAt: 1000 });
  expect(avatar.avatarKey).toBe(key);
  expect(store.db.prepare('SELECT avatar_key FROM users WHERE id=?').get(user.id)).toEqual({ avatar_key: key });
});
