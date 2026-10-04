import Sqlite from 'better-sqlite3';
import { createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Y from 'yjs';
import { SCHEMA_VERSION } from '../../model/src/document.js';

export type Role = 'owner' | 'editor' | 'viewer';
export interface User { id: string; username: string }
export interface Board { id: string; title: string; role: Role; updatedAt: number }
export interface Session { user: User; token: string; expiresAt: number; sessionId: string }
export interface Asset { id: string; boardId: string; mimeType: string; size: number; storageKey: string }
export class BoardFullError extends Error { constructor(readonly maxBytes: number) { super('Board storage limit exceeded'); } }
const derivePassword = promisify(scrypt);
const queries = {
  createUser: 'INSERT INTO users VALUES (?,?,?)',
  userByName: 'SELECT id,username FROM users WHERE username=?',
  setPassword: 'UPDATE users SET password_hash=? WHERE id=?',
  revokeSessions: 'DELETE FROM sessions WHERE user_id=?',
  loginUser: 'SELECT * FROM users WHERE username=?',
  passwordHash: 'SELECT password_hash FROM users WHERE id=?',
  expireSessions: 'DELETE FROM sessions WHERE expires_at < ?',
  createSession: 'INSERT INTO sessions VALUES (?,?,?)',
  authenticate: 'SELECT u.id,u.username,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=?',
  logout: 'DELETE FROM sessions WHERE id=?',
  role: 'SELECT role FROM members WHERE board_id=? AND user_id=?',
  board: 'SELECT b.id,b.title,m.role,b.updated_at AS updatedAt FROM boards b JOIN members m ON m.board_id=b.id WHERE b.id=? AND m.user_id=?',
  boards: 'SELECT b.id,b.title,m.role,b.updated_at AS updatedAt FROM boards b JOIN members m ON m.board_id=b.id WHERE m.user_id=? ORDER BY b.updated_at DESC,b.id',
  createBoard: 'INSERT INTO boards VALUES (?,?,?)',
  createMember: 'INSERT INTO members VALUES (?,?,?)',
  createDocument: 'INSERT INTO documents(board_id,snapshot) VALUES (?,?)',
  rename: 'UPDATE boards SET title=?,updated_at=? WHERE id=?',
  setMember: 'INSERT INTO members VALUES (?,?,?) ON CONFLICT(board_id,user_id) DO UPDATE SET role=excluded.role',
  removeMember: 'DELETE FROM members WHERE board_id=? AND user_id=?',
  snapshot: 'SELECT snapshot FROM documents WHERE board_id=?',
  updates: 'SELECT data FROM updates WHERE board_id=? ORDER BY seq',
  appendUpdate: 'INSERT INTO updates(board_id,data) VALUES (?,?)',
  updateStats: 'UPDATE documents SET update_count=update_count+1,update_bytes=update_bytes+? WHERE board_id=?',
  touchBoard: 'UPDATE boards SET updated_at=? WHERE id=?',
  stats: 'SELECT update_count AS updateCount,update_bytes AS updateBytes,length(snapshot) AS snapshotBytes FROM documents WHERE board_id=?',
  compact: 'UPDATE documents SET snapshot=?,update_count=0,update_bytes=0 WHERE board_id=?',
  deleteUpdates: 'DELETE FROM updates WHERE board_id=?',
  addAsset: 'INSERT INTO assets VALUES (?,?,?,?,?)',
  asset: 'SELECT id,board_id AS boardId,mime_type AS mimeType,size,storage_key AS storageKey FROM assets WHERE board_id=? AND id=?',
  dataVersion: 'PRAGMA data_version',
} as const;

export class Store {
  readonly db: Sqlite.Database;
  private readonly statements: Record<keyof typeof queries, Sqlite.Statement>;
  private membershipRevision = 0;
  constructor(readonly filename: string, private secret: string, readonly maxBoardBytes = 64 * 1024 * 1024) {
    if (secret.length < 32) throw new Error('Session secret must contain at least 32 characters');
    if (!Number.isSafeInteger(maxBoardBytes) || maxBoardBytes <= 0) throw new Error('maxBoardBytes must be a positive safe integer');
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Sqlite(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (board_id TEXT NOT NULL REFERENCES boards(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(board_id,user_id));
      CREATE TABLE IF NOT EXISTS documents (board_id TEXT PRIMARY KEY REFERENCES boards(id), snapshot BLOB NOT NULL, update_count INTEGER NOT NULL DEFAULT 0, update_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id), data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_by_board ON updates(board_id,seq);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), mime_type TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL);
    `);
    this.statements = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, this.db.prepare(sql)])) as Record<keyof typeof queries, Sqlite.Statement>;
  }
  /** Local membership writes and commits by other SQLite connections invalidate cached roles. */
  membershipVersion(): string {
    const external = (this.statements.dataVersion.get() as { data_version: number }).data_version;
    return `${this.membershipRevision}:${external}`;
  }
  createUser(username: string, password: string): User {
    if (!/^[\p{L}\p{N}_.@-]{2,80}$/u.test(username) || password.length < 12) throw new Error('Use a 2–80 character username and a password of at least 12 characters');
    const id = randomUUID(), salt = randomBytes(16).toString('hex');
    this.statements.createUser.run(id, username, `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    return { id, username };
  }
  userByName(username: string): User | undefined { return this.statements.userByName.get(username) as User | undefined; }
  setPassword(username: string, password: string): User {
    if (password.length < 12) throw new Error('Use a password of at least 12 characters');
    const user = this.userByName(username); if (!user) throw new Error('User not found');
    const salt = randomBytes(16).toString('hex'), hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
    this.db.transaction(() => {
      this.statements.setPassword.run(hash, user.id);
      this.revokeSessions(user.id);
    })();
    return user;
  }
  revokeSessions(userId: string): void { this.statements.revokeSessions.run(userId); }
  async login(username: string, password: string): Promise<Session | null> {
    const row = this.statements.loginUser.get(username) as { id: string; username: string; password_hash: unknown } | undefined;
    // Missing and corrupt credentials perform the same asynchronous derivation
    // and fixed-length comparison as a wrong password for an existing account.
    const validHash = typeof row?.password_hash === 'string' && /^[0-9a-f]{32}:[0-9a-f]{128}$/i.test(row.password_hash);
    const [salt, expected] = validHash ? (row!.password_hash as string).split(':') : ['0'.repeat(32), '00'.repeat(64)];
    const actual = await derivePassword(password, salt!, 64) as Buffer;
    const matches = timingSafeEqual(actual, Buffer.from(expected!, 'hex'));
    if (!row || !validHash || !matches) return null;
    return this.db.transaction(() => {
      // Password resets can run while the thread pool verifies the old hash.
      const current = this.statements.passwordHash.get(row.id) as { password_hash: unknown } | undefined;
      if (current?.password_hash !== row.password_hash) return null;
      const sessionId = randomUUID(), expiresAt = Date.now() + 12 * 60 * 60 * 1000;
      this.statements.expireSessions.run(Date.now());
      this.statements.createSession.run(sessionId, row.id, expiresAt);
      const user = { id: row.id, username: row.username };
      return { user, expiresAt, sessionId, token: this.sign({ sessionId, userId: row.id, expiresAt }) };
    }).immediate();
  }
  private sign(payload: object): string {
    const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${text}.${createHmac('sha256', this.secret).update(text).digest('base64url')}`;
  }
  authenticate(token: string): Session | null {
    try {
      const parts = token.split('.'); if (parts.length !== 2) return null;
      const expected = createHmac('sha256', this.secret).update(parts[0]!).digest(), signature = Buffer.from(parts[1]!, 'base64url');
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
      const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { sessionId: string; userId: string; expiresAt: number };
      if (typeof payload.sessionId !== 'string' || typeof payload.userId !== 'string' || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
      const row = this.statements.authenticate.get(payload.sessionId, payload.userId) as (User & { expires_at: number }) | undefined;
      if (!row || row.expires_at !== payload.expiresAt) return null;
      return { user: { id: row.id, username: row.username }, expiresAt: row.expires_at, token, sessionId: payload.sessionId };
    } catch { return null; }
  }
  logout(sessionId: string): void { this.statements.logout.run(sessionId); }
  role(boardId: string, userId: string): Role | undefined { return (this.statements.role.get(boardId, userId) as { role: Role } | undefined)?.role; }
  board(boardId: string, userId: string): Board | undefined {
    return this.statements.board.get(boardId, userId) as Board | undefined;
  }
  boards(userId: string): Board[] { return this.statements.boards.all(userId) as Board[]; }
  createBoard(userId: string, title: string): Board {
    const board: Board = { id: randomUUID(), title, role: 'owner', updatedAt: Date.now() };
    const doc = new Y.Doc();
    doc.transact(() => { const meta = doc.getMap('meta'); meta.set('title', title); meta.set('createdAt', board.updatedAt); meta.set('schemaVersion', SCHEMA_VERSION); });
    const snapshot = Y.encodeStateAsUpdate(doc); doc.destroy();
    if (snapshot.byteLength > this.maxBoardBytes) throw new BoardFullError(this.maxBoardBytes);
    this.db.transaction(() => {
      this.statements.createBoard.run(board.id, title, board.updatedAt);
      this.statements.createMember.run(board.id, userId, 'owner');
      this.statements.createDocument.run(board.id, Buffer.from(snapshot));
    })(); return board;
  }
  /** Persist a metadata delta and its SQL projection before broadcasting it. */
  rename(boardId: string, title: string): Uint8Array {
    return this.db.transaction(() => {
      const state = this.loadDocument(boardId); if (!state) throw new Error('Unknown board');
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state);
        let delta: Uint8Array = new Uint8Array([0, 0]);
        doc.on('update', update => { delta = update; });
        doc.getMap('meta').set('title', title);
        if (delta.byteLength !== 2 || delta[0] !== 0 || delta[1] !== 0) this.appendUpdate(boardId, delta);
        this.statements.rename.run(title, Date.now(), boardId);
        return delta;
      } finally { doc.destroy(); }
    }).immediate();
  }
  setMember(boardId: string, userId: string, role: Role): void { this.statements.setMember.run(boardId, userId, role); this.membershipRevision++; }
  removeMember(boardId: string, userId: string): void {
    if (this.role(boardId, userId) === 'owner') throw new Error('Owner membership cannot be removed');
    this.statements.removeMember.run(boardId, userId); this.membershipRevision++;
  }
  loadDocument(boardId: string): Uint8Array | null {
    const row = this.statements.snapshot.get(boardId) as { snapshot: Buffer } | undefined;
    if (!row) return null;
    const updates = this.statements.updates.all(boardId) as { data: Buffer }[];
    return updates.length ? Y.mergeUpdates([row.snapshot, ...updates.map(update => update.data)]) : row.snapshot;
  }
  appendUpdate(boardId: string, update: Uint8Array): void {
    this.db.transaction(() => {
      this.assertUpdateFits(boardId, update.byteLength);
      this.statements.appendUpdate.run(boardId, Buffer.from(update));
      this.statements.updateStats.run(update.byteLength, boardId);
      this.statements.touchBoard.run(Date.now(), boardId);
    })();
  }
  stats(boardId: string): { updateCount: number; updateBytes: number; snapshotBytes: number } {
    return this.statements.stats.get(boardId) as { updateCount: number; updateBytes: number; snapshotBytes: number };
  }
  needsCompaction(boardId: string): boolean { const stats = this.stats(boardId); return stats.updateCount >= 10_000 || stats.updateBytes >= 5 * 1024 * 1024; }
  assertUpdateFits(boardId: string, bytes: number): void {
    const stats = this.stats(boardId);
    if (stats.snapshotBytes + stats.updateBytes + bytes > this.maxBoardBytes) throw new BoardFullError(this.maxBoardBytes);
  }
  compact(boardId: string, state?: Uint8Array): void {
    const snapshot = state ?? this.loadDocument(boardId); if (!snapshot) throw new Error('Unknown board');
    if (snapshot.byteLength > this.maxBoardBytes) throw new BoardFullError(this.maxBoardBytes);
    this.db.transaction(() => {
      this.statements.compact.run(Buffer.from(snapshot), boardId);
      this.statements.deleteUpdates.run(boardId);
    })();
  }
  addAsset(asset: Asset): void { this.statements.addAsset.run(asset.id, asset.boardId, asset.mimeType, asset.size, asset.storageKey); }
  asset(boardId: string, assetId: string): Asset | undefined { return this.statements.asset.get(boardId, assetId) as Asset | undefined; }
  backup(path: string) { return this.db.backup(path); }
  close(): void { this.db.close(); }
}
