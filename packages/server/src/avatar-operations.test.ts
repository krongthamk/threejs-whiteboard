import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createBackup, gcAssets, restoreBackup } from './operations.js';
import { acquireMaintenanceLease } from './maintenance.js';

const secret = 'avatar-operations-test-secret-at-least-32-characters';
const fingerprint = 'a'.repeat(64);
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-avatar-operations-')), assets = join(directory, 'assets');
  mkdirSync(assets); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'whiteboard.sqlite'), secret);
  cleanups.push(() => { if (store.db.open) store.close(); });
  const user = store.createExternalUser('avatar@example.com', 'Avatar 日本語');
  store.linkIdentity({ provider: 'google', subject: 'avatar-subject', userId: user.id, email: 'avatar@example.com' });
  const board = store.createBoard(user.id, 'Avatar backup board');
  return { directory, assets, store, user, board };
}
function blob(context: ReturnType<typeof fixture>, key: string = randomUUID()) {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const path = join(context.assets, key); writeFileSync(path, bytes); return { key, bytes, path };
}
function setAvatar(context: ReturnType<typeof fixture>, key: string, updatedAt = 1000) {
  context.store.setAvatar(context.user.id, { storageKey: key, urlFingerprint: fingerprint, updatedAt });
}
function state(context: ReturnType<typeof fixture>) {
  return {
    assets: context.store.db.prepare('SELECT * FROM assets ORDER BY id').all(),
    users: context.store.db.prepare('SELECT * FROM users ORDER BY id').all(),
    documents: context.store.db.prepare('SELECT * FROM documents ORDER BY board_id').all(),
    updates: context.store.db.prepare('SELECT * FROM updates ORDER BY seq').all(),
  };
}

test('avatar-only backup restores identity/profile and exact blob with manifest1 board-asset count unchanged', async () => {
  const context = fixture(), avatar = blob(context); setAvatar(context, avatar.key);
  const before = state(context), profile = context.store.userProfile(context.user.id);
  const backup = join(context.directory, 'backup'), restoredDirectory = join(context.directory, 'restored');
  const manifest = await createBackup(context.store, context.assets, secret, backup);
  expect(manifest).toMatchObject({ version: 1, boards: 1, assets: 0 });
  expect(Object.keys(manifest.files).sort()).toEqual(['assets/' + avatar.key, 'session-secret', 'whiteboard.sqlite'].sort());
  expect(readFileSync(join(backup, 'assets', avatar.key))).toEqual(avatar.bytes);
  expect(restoreBackup(backup, restoredDirectory)).toEqual(manifest);
  const restored = new Store(join(restoredDirectory, 'whiteboard.sqlite'), secret);
  try {
    expect(restored.userProfile(context.user.id)).toEqual(profile);
    expect(restored.userByIdentity('google', 'avatar-subject')).toEqual(profile);
    expect(readFileSync(join(restoredDirectory, 'assets', avatar.key))).toEqual(avatar.bytes);
    expect(restored.db.prepare('SELECT * FROM documents ORDER BY board_id').all()).toEqual(before.documents);
    expect(restored.db.prepare('SELECT * FROM updates ORDER BY seq').all()).toEqual(before.updates);
  } finally { restored.close(); }
  expect(state(context)).toEqual(before);
});

test('snapshot avatar remains copyable across concurrent replacement and GC is excluded through the copy', async () => {
  const context = fixture(), original = blob(context), replacement = blob(context); setAvatar(context, original.key);
  const backupMethod = context.store.backup.bind(context.store);
  vi.spyOn(context.store, 'backup').mockImplementation(async path => {
    const metadata = await backupMethod(path);
    setAvatar(context, replacement.key, 2000);
    expect(() => gcAssets(context.store, context.assets)).toThrow('busy');
    return metadata;
  });
  const destination = join(context.directory, 'snapshot-backup');
  const manifest = await createBackup(context.store, context.assets, secret, destination);
  expect(Object.keys(manifest.files)).toContain('assets/' + original.key);
  expect(Object.keys(manifest.files)).not.toContain('assets/' + replacement.key);
  expect(readFileSync(join(destination, 'assets', original.key))).toEqual(original.bytes);
  expect(existsSync(original.path)).toBe(true);
  expect(gcAssets(context.store, context.assets)).toEqual({ removedAssets: 0, removedBlobs: 1, leftoverBlobs: [] });
  expect(existsSync(original.path)).toBe(false); expect(readFileSync(replacement.path)).toEqual(replacement.bytes);
});

test('shared avatar/board storage key is copied once and retained after orphan asset-row removal', async () => {
  const context = fixture(), avatar = blob(context), assetId = randomUUID(); setAvatar(context, avatar.key);
  context.store.addAsset({ id: assetId, boardId: context.board.id, storageKey: avatar.key, mimeType: 'image/png', size: avatar.bytes.length });
  const before = Buffer.from(context.store.loadDocument(context.board.id)!);
  const manifest = await createBackup(context.store, context.assets, secret, join(context.directory, 'shared-backup'));
  expect(manifest.assets).toBe(1); expect(Object.keys(manifest.files).filter(key => key.startsWith('assets/'))).toEqual(['assets/' + avatar.key]);
  expect(gcAssets(context.store, context.assets)).toEqual({ removedAssets: 1, removedBlobs: 0, leftoverBlobs: [] });
  expect(context.store.asset(context.board.id, assetId)).toBeUndefined(); expect(readFileSync(avatar.path)).toEqual(avatar.bytes);
  expect(Buffer.from(context.store.loadDocument(context.board.id)!)).toEqual(before);
});

test.each(['canonical', 'case-alias'])('postcommit %s avatar reference protects an already classified orphan candidate before unlink', spelling => {
  const context = fixture(), avatar = blob(context), id = randomUUID();
  context.store.addAsset({ id, boardId: context.board.id, storageKey: avatar.key, mimeType: 'image/png', size: avatar.bytes.length });
  context.store.db.exec(`CREATE TRIGGER adopt_avatar AFTER DELETE ON assets BEGIN UPDATE users SET avatar_key=${spelling === 'case-alias' ? 'upper(OLD.storage_key)' : 'OLD.storage_key'} WHERE id='${context.user.id}'; END`);
  expect(gcAssets(context.store, context.assets)).toEqual({ removedAssets: 1, removedBlobs: 0, leftoverBlobs: [] });
  expect(readFileSync(avatar.path)).toEqual(avatar.bytes);
  expect(context.store.userProfile(context.user.id)?.avatarKey).toBe(spelling === 'case-alias' ? avatar.key.toUpperCase() : avatar.key);
  if (spelling === 'case-alias') expect(() => gcAssets(context.store, context.assets)).toThrow('Unsafe avatar storage key');
  else expect(gcAssets(context.store, context.assets)).toEqual({ removedAssets: 0, removedBlobs: 0, leftoverBlobs: [] });
});

test.each(['missing', 'traversal', 'empty', 'non-uuid', 'uppercase', 'symlink', 'directory'])('invalid referenced avatar %s fails backup and GC before mutation', async fault => {
  const context = fixture(), avatar = blob(context), orphan = blob(context), orphanId = randomUUID();
  context.store.addAsset({ id: orphanId, boardId: context.board.id, storageKey: orphan.key, mimeType: 'image/png', size: orphan.bytes.length });
  let key: string = avatar.key;
  if (fault === 'missing') rmSync(avatar.path);
  if (fault === 'traversal') key = '../whiteboard.sqlite';
  if (fault === 'empty') key = '';
  if (fault === 'non-uuid') { key = 'legacy-avatar'; writeFileSync(join(context.assets, key), avatar.bytes); }
  if (fault === 'uppercase') key = key.toUpperCase();
  if (fault === 'symlink') { rmSync(avatar.path); symlinkSync(orphan.path, avatar.path); }
  if (fault === 'directory') { rmSync(avatar.path); mkdirSync(avatar.path); }
  // Corrupt persisted state deliberately bypasses the Store's normal input guard.
  context.store.db.prepare('UPDATE users SET avatar_key=? WHERE id=?').run(key, context.user.id);
  const before = state(context), destination = join(context.directory, 'invalid-backup');
  await expect(createBackup(context.store, context.assets, secret, destination)).rejects.toThrow();
  expect(existsSync(destination)).toBe(false); expect(state(context)).toEqual(before);
  expect(() => gcAssets(context.store, context.assets)).toThrow(); expect(state(context)).toEqual(before);
  expect(readFileSync(orphan.path)).toEqual(orphan.bytes);
  acquireMaintenanceLease(context.store.filename, 'exclusive').release();
});

test('actual case-insensitive avatar UUID alias is rejected without deleting the live file', ({ skip }) => {
  const context = fixture(), avatar = blob(context, 'abcdef12-1234-4123-8123-abcdef123456');
  // The portable corrupted-key test above covers every platform. This control
  // specifically exercises the dangerous shared inode on case-insensitive FS.
  const alias = join(context.assets, avatar.key.toUpperCase());
  if (!existsSync(alias)) skip('Case-sensitive filesystem: portable corrupted-key guard is covered above');
  expect(readFileSync(alias)).toEqual(avatar.bytes);
  context.store.db.prepare('UPDATE users SET avatar_key=? WHERE id=?').run(avatar.key.toUpperCase(), context.user.id);
  const before = state(context);
  let failure: unknown;
  try { gcAssets(context.store, context.assets); } catch (error) { failure = error; }
  expect(existsSync(avatar.path), 'live physical avatar file').toBe(true);
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe('Unsafe avatar storage key');
  expect(readFileSync(alias)).toEqual(avatar.bytes); expect(state(context)).toEqual(before);
});

test('orphan uppercase board-asset key cannot unlink a canonical live avatar case alias', () => {
  const context = fixture(), avatar = blob(context, 'abcdef12-1234-4123-8123-abcdef123456'), id = randomUUID();
  setAvatar(context, avatar.key);
  context.store.addAsset({ id, boardId: context.board.id, storageKey: avatar.key.toUpperCase(), mimeType: 'image/png', size: avatar.bytes.length });
  if (existsSync(join(context.assets, avatar.key.toUpperCase()))) expect(readFileSync(join(context.assets, avatar.key.toUpperCase()))).toEqual(avatar.bytes);
  const documents = state(context).documents;
  expect(gcAssets(context.store, context.assets)).toEqual({ removedAssets: 1, removedBlobs: 0, leftoverBlobs: [] });
  expect(context.store.asset(context.board.id, id)).toBeUndefined();
  expect(readFileSync(avatar.path)).toEqual(avatar.bytes); expect(state(context).documents).toEqual(documents);
});

test('reserved session-secret case alias refuses GC without touching the protected leaf or rows', () => {
  const context = fixture(), path = join(context.assets, 'session-secret'); writeFileSync(path, 'protected local secret');
  context.store.addAsset({ id: randomUUID(), boardId: context.board.id, storageKey: 'SESSION-SECRET', mimeType: 'image/png', size: 1 });
  const before = state(context);
  let failure: unknown;
  try { gcAssets(context.store, context.assets); } catch (error) { failure = error; }
  expect(existsSync(path), 'reserved physical file').toBe(true);
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe('Unsafe asset storage key');
  expect(readFileSync(path, 'utf8')).toBe('protected local secret'); expect(state(context)).toEqual(before);
});
