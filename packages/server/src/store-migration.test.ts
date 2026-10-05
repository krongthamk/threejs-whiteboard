import { afterEach, expect, test, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createHash, createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { BoardDocument } from '../../model/src/document';
import { documentToSvg } from '../../model/src/svg';
import { Store } from './store';

const fixtures = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const provenance = JSON.parse(readFileSync(join(fixtures, 'schema2-pre-f1.provenance.json'), 'utf8'));
const secret: string = provenance.syntheticCredentials.sessionSecret;
const paths: string[] = [], stores: Store[] = [];
const artifacts = () => provenance.artifacts.map((a: { path: string }) => createHash('sha256').update(readFileSync(join(fixtures, a.path))).digest('hex'));
const originalHashes = artifacts();
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); expect(artifacts()).toEqual(originalHashes); });
function copy() { const path = mkdtempSync(join(tmpdir(), 'whiteboard-migration-')); paths.push(path); const filename = join(path, 'whiteboard.sqlite'); copyFileSync(join(fixtures, 'schema2-pre-f1.sqlite'), filename); return filename; }
function open(filename: string) { const store = new Store(filename, secret); stores.push(store); return store; }
function legacyRows(db: Sqlite.Database) {
  return Object.fromEntries(['sessions', 'boards', 'members', 'documents', 'updates', 'assets', 'sqlite_sequence'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]).concat([['users', db.prepare('SELECT id,username,password_hash FROM users ORDER BY rowid').all()]]));
}
function oldSchema(db: Sqlite.Database) { return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(); }

test('migrates an immutable pre-feature copy without changing passwords, sessions, FKs, document bytes, clocks or SVG', async () => {
  const filename = copy(), old = new Sqlite(filename), expiresAt = Date.now() + 3600000, userId = provenance.syntheticCredentials.users[0].id;
  old.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)').run('pre-migration-session', userId, expiresAt);
  const payload = Buffer.from(JSON.stringify({ sessionId: 'pre-migration-session', userId, expiresAt })).toString('base64url');
  const token = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  const before = legacyRows(old); expect(old.pragma('user_version', { simple: true })).toBe(0); old.close();
  const store = open(filename);
  expect(store.db.pragma('user_version', { simple: true })).toBe(1); expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(legacyRows(store.db)).toEqual(before); expect(store.db.pragma('foreign_key_check')).toEqual([]); expect(store.db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(store.authenticate(token)?.user).toMatchObject({ id: userId, name: 'legacy.owner', avatarUrl: null });
  for (const user of provenance.syntheticCredentials.users) { expect((await store.login(user.username, provenance.syntheticCredentials.password))?.user.id).toBe(user.id); expect(store.role(provenance.boardId, user.id)).toBe(user.role); }
  const state = store.loadDocument(provenance.boardId)!, doc = new Y.Doc(); Y.applyUpdate(doc, state);
  const board = new BoardDocument(doc), expected = JSON.parse(readFileSync(join(fixtures, 'schema2-pre-f1.expected.json'), 'utf8'));
  try {
    expect(board.schemaVersion).toBe(2); expect(board.readAll()).toEqual(expected.elements);
    const image = readFileSync(join(fixtures, provenance.asset.storageKey)).toString('base64');
    expect(documentToSvg(board.readAll(), { title: expected.metadata.title, assetUrl: () => 'data:image/png;base64,' + image }) + '\n').toBe(readFileSync(join(fixtures, 'schema2-pre-f1.expected.svg'), 'utf8'));
    expect(board.writerClock('101')).toBeGreaterThan(0); expect(board.writerClock('202')).toBeGreaterThan(0);
    expect(Buffer.from(store.loadDocument(provenance.boardId)!).equals(Buffer.from(state))).toBe(true);
  } finally { board.destroy(); }
  const migrated = legacyRows(store.db), second = open(filename); expect(legacyRows(second.db)).toEqual(migrated); expect(second.db.pragma('user_version', { simple: true })).toBe(1);
});

test('fresh stores use migration1 and accept a real NULL password without changing the password account path', () => {
  const store = open(':memory:'); expect(store.db.pragma('user_version', { simple: true })).toBe(1);
  const external = store.createExternalUser('New+User@Example.com', 'External');
  expect(store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(external.id)).toEqual({ password_hash: null });
});

test.each(['future', 'extra-column', 'missing-table', 'type-boundary', 'quoted-constraint', 'constraint-literal'])('rejects unknown %s schema without changing existing rows/schema', kind => {
  const filename = copy(), db = new Sqlite(filename);
  if (kind === 'future') db.pragma('user_version=2');
  else if (kind === 'extra-column') db.exec('ALTER TABLE users ADD COLUMN unexpected TEXT');
  else if (kind === 'missing-table') db.exec('DROP TABLE sessions');
  else {
    // Use public DDL; SQLite's defensive mode correctly disallows writable_schema.
    const table = kind !== 'constraint-literal' ? 'users' : 'members';
    const original = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql;
    const replacement = original.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_unknown`)
      .replace(table === 'users' ? 'password_hash TEXT NOT NULL' : "'owner'", kind === 'type-boundary' ? 'password_hash TEXTNOTNULL' : kind === 'quoted-constraint' ? 'password_hash "TEXT" "NOT" "NULL"' : "'OWNER'");
    db.pragma('foreign_keys=OFF'); db.exec(replacement);
    db.exec(table === 'users' ? 'INSERT INTO users_unknown SELECT * FROM users' : "INSERT INTO members_unknown SELECT board_id,user_id,CASE role WHEN 'owner' THEN 'OWNER' ELSE role END FROM members");
    db.exec(`DROP TABLE ${table}`); db.exec(`ALTER TABLE ${table}_unknown RENAME TO ${table}`);
  }
  const schema = oldSchema(db), users = db.prepare('SELECT * FROM users').all(), version = db.pragma('user_version', { simple: true }); db.close();
  expect(() => new Store(filename, secret)).toThrow(/schema|version/i);
  const check = new Sqlite(filename); try { expect(oldSchema(check)).toEqual(schema); expect(check.prepare('SELECT * FROM users').all()).toEqual(users); expect(check.pragma('user_version', { simple: true })).toBe(version); } finally { check.close(); }
});

test('a forced mid-migration DDL failure rolls back all changes, restores FK mode and closes before retry', () => {
  const filename = copy(), old = new Sqlite(filename), before = legacyRows(old), schema = oldSchema(old); old.close();
  const exec = Sqlite.prototype.exec, close = Sqlite.prototype.close; let restoredForeignKeys: unknown;
  vi.spyOn(Sqlite.prototype, 'exec').mockImplementation(function (this: Sqlite.Database, sql: string) { if (sql.includes('CREATE TABLE identities')) throw Error('forced migration failure'); return exec.call(this, sql); });
  const closing = vi.spyOn(Sqlite.prototype, 'close').mockImplementation(function (this: Sqlite.Database) { restoredForeignKeys = this.pragma('foreign_keys', { simple: true }); return close.call(this); });
  expect(() => new Store(filename, secret)).toThrow('forced migration failure'); expect(closing).toHaveBeenCalledOnce(); expect(restoredForeignKeys).toBe(1);
  vi.restoreAllMocks(); const check = new Sqlite(filename);
  try { expect(legacyRows(check)).toEqual(before); expect(oldSchema(check)).toEqual(schema); expect(check.pragma('user_version', { simple: true })).toBe(0); } finally { check.close(); }
  expect(open(filename).db.pragma('user_version', { simple: true })).toBe(1);
});

test('foreign-key violations fail migration atomically rather than silently losing dependent rows', () => {
  const filename = copy(), old = new Sqlite(filename); old.pragma('foreign_keys=OFF'); old.prepare('INSERT INTO sessions VALUES (?,?,?)').run('dangling', 'missing-user', Date.now() + 3600000);
  const before = legacyRows(old), schema = oldSchema(old); old.close();
  expect(() => new Store(filename, secret)).toThrow(/foreign.key/i);
  const check = new Sqlite(filename); try { expect(legacyRows(check)).toEqual(before); expect(oldSchema(check)).toEqual(schema); expect(check.pragma('user_version', { simple: true })).toBe(0); } finally { check.close(); }
});
