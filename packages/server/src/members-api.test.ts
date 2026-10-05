import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhiteboardServer } from './server';
import { Store } from './store';

const fileRead = vi.hoisted(() => ({ after: undefined as (() => void) | undefined, assetDirectory: '', opens: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).startsWith(fileRead.assetDirectory + '/') && fileRead.assetDirectory) fileRead.opens++;
      return fs.openSync(...args);
    }) as typeof fs.openSync,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      if (typeof args[0] === 'number' && fileRead.after) { const action = fileRead.after; fileRead.after = undefined; action(); }
      return result;
    }) as typeof fs.readFileSync,
  };
});

const secret = 'members-api-session-secret-at-least-32-characters';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { fileRead.after = undefined; fileRead.assetDirectory = ''; fileRead.opens = 0; for (const action of cleanups.splice(0).reverse()) await action(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-members-api-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'whiteboard.sqlite'), assetDirectory = join(directory, 'assets');
  const app = createWhiteboardServer({ databasePath: filename, assetDirectory, sessionSecret: secret, port: 0 });
  cleanups.push(() => app.close());
  const owner = app.store.createUser('owner', 'existing-owner-password');
  const editor = app.store.resolveExternalIdentity({ provider: 'google', subject: 'private-member-subject', email: 'member@example.test', displayName: 'Editor Name' });
  const viewer = app.store.createExternalUser('viewer@example.test', 'Viewer Name');
  const outsider = app.store.createExternalUser('outsider@example.test', 'Outsider Name');
  const solo = app.store.createExternalUser('solo@example.test', 'Solo Name');
  const board = app.store.createBoard(owner.id, 'Member-only profiles');
  app.store.setMember(board.id, editor.id, 'editor'); app.store.setMember(board.id, viewer.id, 'viewer');
  const sessions = Object.fromEntries(Object.entries({ owner, editor, viewer, outsider, solo }).map(([key, user]) => [key, app.store.createSession(user.id)]));
  const avatars = {} as Record<'editor' | 'solo', string>;
  for (const key of ['editor', 'solo'] as const) {
    const user = key === 'editor' ? editor : solo, storageKey = randomUUID();
    writeFileSync(join(assetDirectory, storageKey), png, { mode: 0o600 });
    avatars[key] = app.store.setAvatar(user.id, { storageKey, urlFingerprint: 'a'.repeat(64), updatedAt: 123 }).avatarUrl!;
  }
  const external = new Store(filename, secret); cleanups.push(() => external.close());
  await app.listen();
  fileRead.assetDirectory = assetDirectory; fileRead.opens = 0;
  const request = (path: string, actor: keyof typeof sessions | null = 'owner', method = 'GET') => fetch(`http://127.0.0.1:${app.port}${path}`, {
    method, headers: actor ? { Authorization: `Bearer ${sessions[actor]!.token}` } : {}, redirect: 'error',
  });
  return { app, external, board, owner, editor, viewer, outsider, solo, sessions, avatars, assetDirectory, request };
}
const publicKeys = ['avatarUrl', 'id', 'name', 'username'];
const noStore = (response: Response) => expect(response.headers.get('cache-control')).toBe('no-store');

test('members are a direct public array for owner, editor and viewer, with deterministic ordering and current profiles', async () => {
  const { app, external, request, board, owner, editor, viewer } = await fixture();
  const before = app.store.db.prepare('SELECT snapshot,update_count,update_bytes FROM documents WHERE board_id=?').get(board.id);
  for (const actor of ['owner', 'editor', 'viewer'] as const) {
    const response = await request(`/api/boards/${board.id}/members`, actor); expect(response.status).toBe(200); noStore(response);
    const members = await response.json(); expect(Array.isArray(members)).toBe(true);
    expect(members).toEqual([
      { id: editor.id, username: 'member@example.test', name: 'Editor Name', avatarUrl: app.store.userProfile(editor.id)!.avatarUrl, role: 'editor' },
      { id: owner.id, username: 'owner', name: 'owner', avatarUrl: null, role: 'owner' },
      { id: viewer.id, username: 'viewer@example.test', name: 'Viewer Name', avatarUrl: null, role: 'viewer' },
    ]);
    for (const member of members) expect(Object.keys(member).sort()).toEqual([...publicKeys, 'role'].sort());
  }
  external.resolveExternalIdentity({ provider: 'google', subject: 'private-member-subject', email: editor.username, displayName: 'Fresh Member Name' });
  expect((await (await request(`/api/boards/${board.id}/members`, 'viewer')).json())[0].name).toBe('Fresh Member Name');
  const head = await request(`/api/boards/${board.id}/members`, 'viewer', 'HEAD'); expect(head.status).toBe(200); noStore(head); expect(await head.text()).toBe('');
  expect(app.store.db.prepare('SELECT snapshot,update_count,update_bytes FROM documents WHERE board_id=?').get(board.id)).toEqual(before);
});

test('member list denies anonymous, missing, outside and removed accounts without broadening viewer writes', async () => {
  const { request, external, board, viewer } = await fixture();
  for (const method of ['GET', 'HEAD']) {
    for (const [path, actor, status] of [[`/api/boards/${board.id}/members`, null, 401], [`/api/boards/${board.id}/members`, 'outsider', 404], ['/api/boards/not-a-board/members', 'owner', 404]] as const) {
      const response = await request(path, actor, method); expect(response.status).toBe(status); noStore(response); if (method === 'HEAD') expect(await response.text()).toBe('');
    }
  }
  expect((await request(`/api/boards/${board.id}/members`, 'viewer', 'POST')).status).toBe(403);
  external.removeMember(board.id, viewer.id);
  const removed = await request(`/api/boards/${board.id}/members`, 'viewer'); expect(removed.status).toBe(404); noStore(removed);
});

test('profile returns only public fields for self or any current common-board member, including viewer', async () => {
  const { app, request, editor, viewer, owner, solo } = await fixture();
  for (const [target, actor] of [[editor, 'owner'], [editor, 'viewer'], [owner, 'editor'], [solo, 'solo']] as const) {
    const response = await request(`/api/users/${target.id}`, actor); expect(response.status).toBe(200); noStore(response);
    const user = await response.json(); expect(user).toEqual(app.store.userByName(target.username)); expect(Object.keys(user).sort()).toEqual(publicKeys);
    const head = await request(`/api/users/${target.id}`, actor, 'HEAD'); expect(head.status).toBe(200); noStore(head); expect(await head.text()).toBe('');
  }
  expect(app.store.boards(solo.id)).toEqual([]); expect(viewer.id).not.toBe(editor.id);
});

test('profile denies unknown/nonshared users without revealing private fields and keeps signed-out401', async () => {
  const { request, editor, solo } = await fixture();
  for (const method of ['GET', 'HEAD']) {
    for (const [path, actor, status] of [[`/api/users/${editor.id}`, 'outsider', 404], [`/api/users/${solo.id}`, 'owner', 404], ['/api/users/unknown-user', 'owner', 404], [`/api/users/${editor.id}`, null, 401]] as const) {
      const response = await request(path, actor, method); expect(response.status).toBe(status); noStore(response);
      const body = await response.text(); expect(body).not.toMatch(/password|fingerprint|avatarKey|private-member-subject|provider/);
      if (method === 'HEAD') expect(body).toBe('');
    }
  }
});

test('avatar GET and HEAD use fresh self/common-board authorization, exact bytes and no-store', async () => {
  const { request, avatars } = await fixture();
  for (const [path, actor] of [[avatars.editor, 'owner'], [avatars.editor, 'viewer'], [avatars.editor, 'editor'], [avatars.solo, 'solo']] as const) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, actor, method); expect(response.status).toBe(200); noStore(response);
      expect(response.headers.get('content-type')).toBe('image/png'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-length')).toBe(String(png.length));
      expect(Buffer.from(await response.arrayBuffer()).equals(method === 'HEAD' ? Buffer.alloc(0) : png)).toBe(true);
    }
  }
});

test('unauthorized avatar loads fail before opening a file; unknown and no-avatar users remain no-store404', async () => {
  const { request, avatars, owner } = await fixture();
  for (const method of ['GET', 'HEAD']) {
    for (const [path, actor, status] of [[avatars.editor, 'outsider', 404], [avatars.solo, 'owner', 404], [avatars.editor, null, 401], ['/api/users/unknown/avatar', 'owner', 404], [`/api/users/${owner.id}/avatar`, 'owner', 404]] as const) {
      const before = fileRead.opens, response = await request(path, actor, method); expect(response.status).toBe(status); noStore(response);
      expect(fileRead.opens).toBe(before); if (method === 'HEAD') expect(await response.text()).toBe('');
    }
  }
});

test('cross-connection removal denies the last common board but another common board legitimately preserves access', async () => {
  const { app, external, request, editor, owner, board, avatars } = await fixture();
  const second = app.store.createBoard(owner.id, 'Second shared board'); app.store.setMember(second.id, editor.id, 'viewer');
  external.removeMember(board.id, editor.id);
  expect((await request(`/api/users/${editor.id}`)).status).toBe(200); expect((await request(avatars.editor)).status).toBe(200);
  external.removeMember(second.id, editor.id);
  for (const method of ['GET', 'HEAD']) for (const path of [`/api/users/${editor.id}`, avatars.editor]) {
    const response = await request(path, 'owner', method); expect(response.status).toBe(404); noStore(response);
  }
  expect((await request(avatars.editor, 'editor')).status).toBe(200);
});

test.each(['GET', 'HEAD'])('membership revoked by a real second Store after actual avatar read refuses %s bytes', async method => {
  const { external, request, board, editor, avatars } = await fixture(); let ran = false;
  fileRead.after = () => { external.removeMember(board.id, editor.id); ran = true; };
  const response = await request(avatars.editor, 'owner', method); expect(ran).toBe(true);
  expect(response.status).toBe(404); noStore(response); expect(response.headers.get('content-type')).toContain('application/json');
  if (method === 'HEAD') expect(await response.text()).toBe(''); else expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(false);
});

test.each(['GET', 'HEAD'])('session revoked by a real second Store after actual avatar read retains %s401', async method => {
  const { external, request, sessions, avatars } = await fixture(); let ran = false;
  fileRead.after = () => { external.logout(sessions.owner!.sessionId); ran = true; };
  const response = await request(avatars.editor, 'owner', method); expect(ran).toBe(true);
  expect(response.status).toBe(401); noStore(response); if (method === 'HEAD') expect(await response.text()).toBe('');
});

test('profile avatar revision changed after actual read refuses stale bytes, then serves the current copy', async () => {
  const { external, request, editor, avatars, assetDirectory } = await fixture();
  const replacement = randomUUID(); writeFileSync(join(assetDirectory, replacement), png, { mode: 0o600 }); let ran = false;
  fileRead.after = () => { external.setAvatar(editor.id, { storageKey: replacement, urlFingerprint: 'b'.repeat(64), updatedAt: 124 }); ran = true; };
  const stale = await request(avatars.editor); expect(ran).toBe(true); expect(stale.status).toBe(404); noStore(stale);
  const current = await request(external.userProfile(editor.id)!.avatarUrl!); expect(current.status).toBe(200); noStore(current);
  expect(Buffer.from(await current.arrayBuffer()).equals(png)).toBe(true);
});
