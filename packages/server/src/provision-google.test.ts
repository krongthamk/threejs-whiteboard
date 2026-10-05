import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { Store } from './store';

const secret = 'google-provision-test-secret-at-least-32-characters';
const password = 'legacy-provision-password';
const suppliedMarker = 'password-that-google-must-not-use';
const script = fileURLToPath(new URL('./provision.ts', import.meta.url));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-google-provision-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'whiteboard.sqlite'), secret);
  cleanup.push(() => store.close());
  const cli = (args: string[], supplied: string | null = suppliedMarker) => {
    const env = { ...process.env };
    // Neither ambient OAuth configuration nor real operator credentials enter children.
    for (const key of Object.keys(env)) if (key.startsWith('WHITEBOARD_')) delete env[key];
    Object.assign(env, { WHITEBOARD_DATA_DIR: directory, WHITEBOARD_SESSION_SECRET: secret, PORT: '0' });
    if (supplied !== null) env.WHITEBOARD_PASSWORD = supplied;
    return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { env, encoding: 'utf8', timeout: 15_000 });
  };
  return { store, cli };
}

function publicResult(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined(); expect(result.status, String(result.stderr)).toBe(0);
  const output = String(result.stdout);
  expect(output).not.toContain(suppliedMarker);
  const parsed = JSON.parse(output);
  expect(Object.keys(parsed)).toEqual(['user']);
  expect(Object.keys(parsed.user).sort()).toEqual(['avatarUrl', 'id', 'name', 'username']);
  return parsed.user as { id: string; username: string; name: string; avatarUrl: string | null };
}
const rows = (store: Store) => ['users', 'identities', 'sessions', 'boards', 'members', 'documents', 'updates', 'assets', 'oauth_states']
  .map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('--google CLI precreates canonical plus email without a password, session or provider identity', async () => {
  const { store, cli } = fixture();
  const user = publicResult(cli(['--google', 'Pre+User@Example.COM']));
  expect(user).toEqual({ id: expect.any(String), username: 'pre+user@example.com', name: 'pre+user@example.com', avatarUrl: null });
  expect(store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)).toEqual({ password_hash: null });
  expect(store.db.prepare('SELECT * FROM identities').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
  expect(await store.login(user.username, suppliedMarker)).toBeNull();
});

test('--google CLI accepts 254 characters without generating a password or leaking profile fields', () => {
  const { store, cli } = fixture();
  const email = 'x'.repeat(64) + '@' + 'd'.repeat(63) + '.' + 'e'.repeat(63) + '.' + 'f'.repeat(61);
  expect(email).toHaveLength(254);
  const first = publicResult(cli(['--google', email], null));
  expect(first.username).toBe(email); expect(first.name).toHaveLength(80);
  store.setAvatar(first.id, { storageKey: 'e08f85b1-1788-4380-bbc8-a2f443d6f009', updatedAt: 123, urlFingerprint: 'f'.repeat(64) });
  const repeated = publicResult(cli(['--google', email], null));
  expect(repeated).toEqual({ ...first, avatarUrl: `/api/users/${first.id}/avatar?v=123` });
  expect(store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(first.id)).toEqual({ password_hash: null });
});

test('idempotent CLI precreation shares the same account before a verified Google link', () => {
  const { store, cli } = fixture();
  const user = publicResult(cli(['--google', 'Member+Tag@Example.com']));
  const owner = store.createUser('owner', password), board = store.createBoard(owner.id, 'Pre-shared board');
  store.setMember(board.id, user.id, 'editor');
  const before = rows(store);
  expect(publicResult(cli(['--google', 'MEMBER+TAG@example.COM']))).toEqual(user);
  expect(rows(store)).toEqual(before);
  const linked = store.resolveExternalIdentity({ provider: 'google', subject: 'verified-subject', email: user.username, displayName: 'Member 日本語' });
  expect(linked.id).toBe(user.id); expect(store.role(board.id, linked.id)).toBe('editor');
  expect(store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)).toEqual({ password_hash: null });
});

test('CLI canonical reuse preserves exact legacy username, hash, membership and active session', async () => {
  const { store, cli } = fixture(), user = store.createUser('Case@Example.com', password);
  const board = store.createBoard(user.id, 'Legacy membership'), session = store.createSession(user.id);
  const before = rows(store);
  expect(publicResult(cli(['--google', 'case@example.COM']))).toEqual(user);
  expect(rows(store)).toEqual(before); expect(store.authenticate(session.token)?.user.id).toBe(user.id);
  expect(store.role(board.id, user.id)).toBe('owner');
  expect(await store.login('case@example.com', password)).toBeNull();
  expect((await store.login(user.username, password))?.user.id).toBe(user.id);
});

test.each(['private..sentinel@example.com', 'private@-host.example', 'x'.repeat(65) + '@example.com'])('invalid Google CLI email refuses atomically without echoing its value: %s', email => {
  const { store, cli } = fixture(); store.createUser('owner', password);
  const before = rows(store), result = cli(['--google', email]);
  expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Invalid external email'); expect(result.stderr).not.toContain(email);
  expect(result.stderr).not.toContain(suppliedMarker); expect(rows(store)).toEqual(before);
});

test('ambiguous legacy emails refuse atomically without linking either account', () => {
  const { store, cli } = fixture();
  store.createUser('Case@Example.com', password); store.createUser('case@example.com', password);
  const before = rows(store), result = cli(['--google', 'CASE@example.COM']);
  expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Ambiguous external email account'); expect(rows(store)).toEqual(before);
});

test('explicit CLI reset adds an external account password and revokes sessions without unlinking Google', async () => {
  const { store, cli } = fixture(), user = publicResult(cli(['--google', 'reset+google@example.com']));
  store.resolveExternalIdentity({ provider: 'google', subject: 'reset-subject', email: user.username, displayName: 'Reset Member' });
  const session = store.createSession(user.id), identities = store.db.prepare('SELECT * FROM identities').all();
  const reset = publicResult(cli(['--reset-password', user.username]));
  expect(reset.id).toBe(user.id); expect(store.authenticate(session.token)).toBeNull();
  expect(store.db.prepare('SELECT * FROM identities').all()).toEqual(identities);
  expect(store.userByIdentity('google', 'reset-subject')?.id).toBe(user.id);
  const next = (await store.login(user.username, suppliedMarker))!; expect(next.user.id).toBe(user.id);
  const revoked = cli(['--revoke-sessions', user.username]); expect(revoked.status).toBe(0);
  expect(JSON.parse(revoked.stdout)).toEqual({ user: reset, sessionsRevoked: true });
  expect(revoked.stdout).not.toContain(suppliedMarker); expect(store.authenticate(next.token)).toBeNull();
  expect(store.db.prepare('SELECT * FROM identities').all()).toEqual(identities);
});

test('ordinary CLI creation still supports supplied and generated temporary passwords', async () => {
  const { store, cli } = fixture();
  const supplied = publicResult(cli(['ordinary-account']));
  expect((await store.login(supplied.username, suppliedMarker))?.user.id).toBe(supplied.id);
  const generated = cli(['generated-account'], null); expect(generated.status).toBe(0);
  const output = JSON.parse(generated.stdout);
  expect(Object.keys(output).sort()).toEqual(['temporaryPassword', 'user']);
  expect(output.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect((await store.login(output.user.username, output.temporaryPassword))?.user.id).toBe(output.user.id);
});
