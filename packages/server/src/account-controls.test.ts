import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { Store } from './store';

const secret = 'account-control-test-secret-with-at-least-32-chars';
const password = 'original-account-password';
const replacement = 'replacement-account-password';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-account-controls-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'whiteboard.sqlite'), secret);
  cleanup.push(() => store.close()); return { directory, store };
}

test('password replacement invalidates existing sessions and preserves other accounts', async () => {
  const { store } = database(), user = store.createUser('alice', password);
  store.createUser('bob', password);
  const before = (await store.login('alice', password))!, other = (await store.login('bob', password))!;
  expect(() => store.setPassword('alice', 'short')).toThrow('12');
  store.setPassword('alice', replacement);
  expect(await store.login('alice', password)).toBeNull();
  expect((await store.login('alice', replacement))!.user.id).toBe(user.id);
  expect(store.authenticate(before.token)).toBeNull(); expect(store.authenticate(other.token)).not.toBeNull();
  expect(() => store.setPassword('missing', replacement)).toThrow('User not found');
});

test('session revocation clears all sessions for the selected account', async () => {
  const { store } = database(), user = store.createUser('alice', password);
  store.createUser('bob', password);
  const first = (await store.login('alice', password))!, second = (await store.login('alice', password))!, other = (await store.login('bob', password))!;
  store.revokeSessions(user.id);
  expect(store.authenticate(first.token)).toBeNull(); expect(store.authenticate(second.token)).toBeNull();
  expect(store.authenticate(other.token)).not.toBeNull(); expect(await store.login('alice', password)).not.toBeNull();
});

test('provision supports password reset and session revocation without exposing supplied passwords', async () => {
  const { store, directory } = database(), user = store.createUser('alice', password);
  const original = (await store.login('alice', password))!;
  const script = fileURLToPath(new URL('./provision.ts', import.meta.url));
  const cli = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
    env: { ...process.env, WHITEBOARD_DATA_DIR: directory, WHITEBOARD_SESSION_SECRET: secret, WHITEBOARD_PASSWORD: replacement }, encoding: 'utf8',
  });
  const reset = cli('--reset-password', 'alice');
  expect(reset).not.toContain(replacement); expect(JSON.parse(reset).user.id).toBe(user.id);
  expect(store.authenticate(original.token)).toBeNull();
  const next = (await store.login('alice', replacement))!;
  const revoked = cli('--revoke-sessions', 'alice'); expect(JSON.parse(revoked).user.id).toBe(user.id);
  expect(store.authenticate(next.token)).toBeNull();
});
