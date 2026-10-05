import Sqlite from 'better-sqlite3';
import { createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Y from 'yjs';
import { SCHEMA_VERSION } from '../../model/src/document.js';
import { displayName, normalizeExternalEmail } from './identity.js';

export type Role = 'owner' | 'editor' | 'viewer';
export interface User { id: string; username: string; name: string; avatarUrl: string | null }
export interface UserProfile extends User { avatarKey: string | null; avatarUpdatedAt: number | null; avatarUrlFingerprint: string | null }
export interface ExternalIdentity { provider: string; subject: string; email: string; displayName?: string | null }
export interface OAuthState { state: string; nonce: string; verifier: string; returnPath: string; expiresAt: number; browserBindingHash: string }
export interface Board { id: string; title: string; role: Role; updatedAt: number }
export interface Session { user: User; token: string; expiresAt: number; sessionId: string }
export interface Asset { id: string; boardId: string; mimeType: string; size: number; storageKey: string }
export class BoardFullError extends Error { constructor(readonly maxBytes: number) { super('Board storage limit exceeded'); } }
const derivePassword = promisify(scrypt);
const profileFields = 'id,username,display_name AS displayName,avatar_key AS avatarKey,avatar_updated_at AS avatarUpdatedAt,avatar_url_fingerprint AS avatarUrlFingerprint';
const legacySchema = {
  users: 'CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)',
  sessions: 'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL)',
  boards: 'CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  members: "CREATE TABLE members (board_id TEXT NOT NULL REFERENCES boards(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(board_id,user_id))",
  documents: 'CREATE TABLE documents (board_id TEXT PRIMARY KEY REFERENCES boards(id), snapshot BLOB NOT NULL, update_count INTEGER NOT NULL DEFAULT 0, update_bytes INTEGER NOT NULL DEFAULT 0)',
  updates: 'CREATE TABLE updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id), data BLOB NOT NULL)',
  assets: 'CREATE TABLE assets (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), mime_type TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL)',
};
const currentSchema = {
  ...legacySchema,
  users: 'CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NULL, display_name TEXT, avatar_key TEXT, avatar_updated_at INTEGER, avatar_url_fingerprint TEXT)',
  identities: 'CREATE TABLE identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), email TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(provider,subject), UNIQUE(provider,user_id))',
  oauth_states: 'CREATE TABLE oauth_states (state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, return_path TEXT NOT NULL, expires_at INTEGER NOT NULL, browser_binding_hash TEXT NOT NULL)',
};
// Keep token boundaries: TEXTNOTNULL is a type, not TEXT NOT NULL. Preserve
// quoted literal values (CHECK constraints), while SQLite may quote table names.
const sqlSignature = (sql: string) => sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[^\s]/g)!.map((token, index) => {
  if (token.startsWith("'") || token.startsWith('"') && index !== 2) return token;
  // Only CREATE TABLE's name is an identifier we know SQLite quotes on rename.
  // Quoted "NOT" and "NULL" in a type are not constraint keywords.
  return (token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token).toLowerCase();
}).join('\0');
function assertSchema(db: Sqlite.Database, expected: Record<string, string>): void {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];
  if (tables.length !== Object.keys(expected).length || tables.some(table => !expected[table.name] || sqlSignature(table.sql) !== sqlSignature(expected[table.name]!))) throw new Error('Unsupported database schema');
  // Rebuilding users would otherwise silently discard operator-added triggers/indexes.
  const extra = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name='users' AND type IN ('trigger','index') AND sql IS NOT NULL").all();
  if (extra.length) throw new Error('Unsupported users schema');
}
function initializeSchema(db: Sqlite.Database): void {
  const version = db.pragma('user_version', { simple: true });
  if (version !== 0 && version !== 1) throw new Error('Unsupported database version');
  if (version === 1) { assertSchema(db, currentSchema); db.pragma('foreign_keys=ON'); return; }
  // SQLite requires this outside the transaction. Drop old users only after
  // copying; renaming it first would retarget dependent foreign keys.
  db.pragma('foreign_keys=OFF');
  try {
    db.transaction(() => {
      const currentVersion = db.pragma('user_version', { simple: true });
      if (currentVersion === 1) { assertSchema(db, currentSchema); return; }
      if (currentVersion !== 0) throw new Error('Unsupported database version');
      const count = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
      if (!count) {
        for (const sql of Object.values(legacySchema)) db.exec(sql);
        db.exec('CREATE INDEX updates_by_board ON updates(board_id,seq)');
      }
      assertSchema(db, legacySchema);
      db.exec(currentSchema.users.replace('CREATE TABLE users ', 'CREATE TABLE users_migration1 '));
      db.exec('INSERT INTO users_migration1(id,username,password_hash) SELECT id,username,password_hash FROM users');
      db.exec('DROP TABLE users'); db.exec('ALTER TABLE users_migration1 RENAME TO users');
      db.exec(currentSchema.identities); db.exec(currentSchema.oauth_states);
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Database foreign-key check failed');
      assertSchema(db, currentSchema); db.pragma('user_version=1');
    }).immediate();
  } finally { db.pragma('foreign_keys=ON'); }
}
interface ProfileRow { id: string; username: string; displayName: string | null; avatarKey: string | null; avatarUpdatedAt: number | null; avatarUrlFingerprint: string | null }
const publicUser = (profile: UserProfile): User => ({ id: profile.id, username: profile.username, name: profile.name, avatarUrl: profile.avatarUrl });
function profile(row: ProfileRow): UserProfile {
  return { id: row.id, username: row.username, name: displayName(row.displayName, row.username), avatarKey: row.avatarKey, avatarUpdatedAt: row.avatarUpdatedAt, avatarUrlFingerprint: row.avatarUrlFingerprint,
    avatarUrl: row.avatarKey ? `/api/users/${encodeURIComponent(row.id)}/avatar?v=${row.avatarUpdatedAt}` : null };
}
function identityFields(provider: string, subject: string): void {
  if (typeof provider !== 'string' || typeof subject !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(provider) || !/^[\x21-\x7e]{1,255}$/.test(subject)) throw new Error('Invalid external identity');
}
function validState(record: OAuthState): void {
  const opaque = /^[a-zA-Z0-9_-]{43,128}$/;
  if (typeof record.state !== 'string' || typeof record.nonce !== 'string' || typeof record.verifier !== 'string' || typeof record.browserBindingHash !== 'string' || !opaque.test(record.state) || !opaque.test(record.nonce) || !/^[a-zA-Z0-9._~-]{43,128}$/.test(record.verifier) || !/^[a-f0-9]{64}$/.test(record.browserBindingHash) ||
    !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now() || record.expiresAt > Date.now() + 600000 || typeof record.returnPath !== 'string' || record.returnPath.length > 2048 || !record.returnPath.startsWith('/') || record.returnPath.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(record.returnPath) || /[\uD800-\uDFFF]/u.test(record.returnPath)) throw new Error('Invalid OAuth state');
}
const queries = {
  createUser: 'INSERT INTO users(id,username,password_hash) VALUES (?,?,?)',
  userByName: `SELECT ${profileFields} FROM users WHERE username=?`,
  userProfile: `SELECT ${profileFields} FROM users WHERE id=?`,
  externalCandidates: `SELECT ${profileFields} FROM users WHERE lower(username)=?`,
  createExternalUser: 'INSERT INTO users(id,username,password_hash,display_name) VALUES (?,?,NULL,?)',
  identity: 'SELECT user_id AS userId FROM identities WHERE provider=? AND subject=?',
  identityByUser: 'SELECT subject FROM identities WHERE provider=? AND user_id=?',
  createIdentity: 'INSERT INTO identities(provider,subject,user_id,email,updated_at) VALUES (?,?,?,?,?)',
  updateIdentity: 'UPDATE identities SET email=?,updated_at=? WHERE provider=? AND subject=?',
  setDisplayName: 'UPDATE users SET display_name=? WHERE id=?',
  setAvatar: 'UPDATE users SET avatar_key=?,avatar_url_fingerprint=?,avatar_updated_at=? WHERE id=?',
  createOAuthState: 'INSERT INTO oauth_states(state,nonce,verifier,return_path,expires_at,browser_binding_hash) VALUES (?,?,?,?,?,?)',
  oauthState: 'SELECT state,nonce,verifier,return_path AS returnPath,expires_at AS expiresAt,browser_binding_hash AS browserBindingHash FROM oauth_states WHERE state=? AND browser_binding_hash=?',
  consumeOAuthState: 'DELETE FROM oauth_states WHERE state=? AND browser_binding_hash=?',
  expireOAuthStates: 'DELETE FROM oauth_states WHERE expires_at<=?',
  setPassword: 'UPDATE users SET password_hash=? WHERE id=?',
  revokeSessions: 'DELETE FROM sessions WHERE user_id=?',
  loginUser: 'SELECT * FROM users WHERE username=?',
  passwordHash: 'SELECT password_hash FROM users WHERE id=?',
  expireSessions: 'DELETE FROM sessions WHERE expires_at < ?',
  createSession: 'INSERT INTO sessions VALUES (?,?,?)',
  authenticate: 'SELECT u.id,u.username,u.display_name AS displayName,u.avatar_key AS avatarKey,u.avatar_updated_at AS avatarUpdatedAt,u.avatar_url_fingerprint AS avatarUrlFingerprint,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=?',
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
    try {
      this.db.pragma('synchronous = FULL'); initializeSchema(this.db);
      this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON');
      this.statements = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, this.db.prepare(sql)])) as Record<keyof typeof queries, Sqlite.Statement>;
    } catch (error) { this.db.close(); throw error; }
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
    return publicUser(this.userProfile(id)!);
  }
  userByName(username: string): User | undefined { const row = this.statements.userByName.get(username) as ProfileRow | undefined; return row && publicUser(profile(row)); }
  userProfile(userId: string): UserProfile | undefined { const row = this.statements.userProfile.get(userId) as ProfileRow | undefined; return row && profile(row); }
  userByIdentity(provider: string, subject: string): UserProfile | undefined {
    identityFields(provider, subject); const row = this.statements.identity.get(provider, subject) as { userId: string } | undefined;
    return row && this.userProfile(row.userId);
  }
  private externalCandidate(email: string): UserProfile | undefined {
    const candidates = (this.statements.externalCandidates.all(email) as ProfileRow[]).filter(row => {
      try { return normalizeExternalEmail(row.username) === email; } catch { return false; }
    });
    if (candidates.length > 1) throw new Error('Ambiguous external email account');
    return candidates[0] && profile(candidates[0]);
  }
  createExternalUser(email: string, name?: string | null): UserProfile {
    const canonical = normalizeExternalEmail(email), boundedName = displayName(name, canonical);
    return this.db.transaction(() => {
      const existing = this.externalCandidate(canonical); if (existing) return existing;
      const id = randomUUID(); this.statements.createExternalUser.run(id, canonical, boundedName); return this.userProfile(id)!;
    }).immediate();
  }
  linkIdentity(input: { provider: string; subject: string; userId: string; email: string }): void {
    identityFields(input.provider, input.subject); const email = normalizeExternalEmail(input.email);
    this.db.transaction(() => {
      if (!this.userProfile(input.userId)) throw new Error('Identity user not found');
      const existing = this.statements.identity.get(input.provider, input.subject) as { userId: string } | undefined;
      if (existing && existing.userId !== input.userId) throw new Error('External identity cannot be reassigned');
      const bound = this.statements.identityByUser.get(input.provider, input.userId) as { subject: string } | undefined;
      if (bound && bound.subject !== input.subject) throw new Error('Account already has an external identity');
      if (existing) this.statements.updateIdentity.run(email, Date.now(), input.provider, input.subject);
      else this.statements.createIdentity.run(input.provider, input.subject, input.userId, email, Date.now());
    }).immediate();
  }
  resolveExternalIdentity(input: ExternalIdentity): UserProfile {
    identityFields(input.provider, input.subject); const email = normalizeExternalEmail(input.email), name = displayName(input.displayName, email);
    return this.db.transaction(() => {
      const user = this.userByIdentity(input.provider, input.subject) ?? this.createExternalUser(email, name);
      this.linkIdentity({ ...input, email, userId: user.id });
      this.statements.setDisplayName.run(name, user.id); return this.userProfile(user.id)!;
    }).immediate();
  }
  setAvatar(userId: string, value: { storageKey: string; urlFingerprint: string; updatedAt: number }): UserProfile {
    if (typeof value.storageKey !== 'string' || typeof value.urlFingerprint !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.storageKey) || !/^[a-f0-9]{64}$/.test(value.urlFingerprint) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new Error('Invalid avatar metadata');
    return this.db.transaction(() => {
      const user = this.userProfile(userId); if (!user) throw new Error('Avatar user not found');
      const updatedAt = Math.max(value.updatedAt, (user.avatarUpdatedAt ?? -1) + 1);
      if (!Number.isSafeInteger(updatedAt)) throw new Error('Invalid avatar revision');
      this.statements.setAvatar.run(value.storageKey.toLowerCase(), value.urlFingerprint, updatedAt, userId); return this.userProfile(userId)!;
    }).immediate();
  }
  createOAuthState(record: OAuthState): void {
    validState(record);
    this.db.transaction(() => {
      this.statements.expireOAuthStates.run(Date.now());
      this.statements.createOAuthState.run(record.state, record.nonce, record.verifier, record.returnPath, record.expiresAt, record.browserBindingHash);
    }).immediate();
  }
  consumeOAuthState(state: string, browserBindingHash: string, now = Date.now()): OAuthState | null {
    if (typeof state !== 'string' || !/^[a-zA-Z0-9_-]{43,128}$/.test(state) || typeof browserBindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(browserBindingHash) || !Number.isSafeInteger(now) || now < 0) return null;
    return this.db.transaction(() => {
      const row = this.statements.oauthState.get(state, browserBindingHash) as OAuthState | undefined;
      if (!row) return null;
      this.statements.consumeOAuthState.run(state, browserBindingHash); return row.expiresAt > now ? row : null;
    }).immediate();
  }
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
      return this.sessionForUser(row.id);
    }).immediate();
  }
  private sessionForUser(userId: string): Session {
    const current = this.userProfile(userId); if (!current) throw new Error('Session user not found');
    const sessionId = randomUUID(), expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    this.statements.expireSessions.run(Date.now()); this.statements.createSession.run(sessionId, userId, expiresAt);
    return { user: publicUser(current), expiresAt, sessionId, token: this.sign({ sessionId, userId, expiresAt }) };
  }
  createSession(userId: string): Session { return this.db.transaction(() => this.sessionForUser(userId)).immediate(); }
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
      const row = this.statements.authenticate.get(payload.sessionId, payload.userId) as (ProfileRow & { expires_at: number }) | undefined;
      if (!row || row.expires_at !== payload.expiresAt) return null;
      return { user: publicUser(profile(row)), expiresAt: row.expires_at, token, sessionId: payload.sessionId };
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
