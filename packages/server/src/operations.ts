import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Store } from './store.js';
import * as Y from 'yjs';
import { CLOCK_PREFIX, clockRootValue, WRITER_PREFIX, plainRecord, causalClockBound, validWriterRecord, SCHEMA_VERSION } from '../../model/src/document-validation.js';
import { acquireMaintenanceLease, canonicalDatabasePath } from './maintenance.js';

export interface AssetGCResult { removedAssets: number; removedBlobs: number; leftoverBlobs: string[] }
const uuidLeaf = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function safeStorageKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]+$/.test(key) || key.toLowerCase() === 'session-secret') throw new Error('Unsafe asset storage key');
}
function safeAssetRoot(store: Store, directory: string): string {
  const stat = lstatSync(resolve(directory));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Asset directory must be a real directory');
  const root = realpathSync(directory), database = canonicalDatabasePath(store.filename);
  if (root === parse(root).root) throw new Error('Asset directory must not be a filesystem root');
  const namedDatabase = store.filename === ':memory:' ? database : join(realpathSync(dirname(resolve(store.filename))), basename(store.filename));
  for (const path of [database, namedDatabase, `${database}.maintenance.sqlite`]) {
    const within = relative(root, path);
    if (!within || !within.startsWith('..' + sep) && within !== '..' && !isAbsolute(within)) throw new Error('Asset directory contains database or maintenance files');
  }
  return root;
}
function regularBlob(root: string, key: string, required = false): boolean {
  safeStorageKey(key);
  try {
    const stat = lstatSync(join(root, key));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe asset blob: ${key}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (required) throw new Error(`Referenced asset blob is missing: ${key}`);
    return false;
  }
}
/** Avatar pointers name immutable UUID blobs independently of board asset rows. */
function avatarStorageKeys(database: Sqlite.Database): string[] {
  const rows = database.prepare('SELECT DISTINCT avatar_key AS key FROM users WHERE avatar_key IS NOT NULL').all() as { key: unknown }[];
  return rows.map(({ key }) => {
    if (typeof key !== 'string' || !uuidLeaf.test(key) || key !== key.toLowerCase()) throw new Error('Unsafe avatar storage key');
    return key;
  });
}
/** Preserve every surviving raw image reference, including losing generations and readable quarantine. */
function rawAssetReferences(update: Uint8Array, boardId: string): Set<string> {
  const doc = new Y.Doc(), references = new Set<string>();
  const entry = (key: string, child: unknown): void => {
    if (key === 'assetId') {
      if (typeof child !== 'string' || !child) throw new Error(`Unrecognizable asset reference in board ${boardId}`);
      references.add(child);
    }
    visit(child);
  };
  const visit = (value: unknown): void => {
    if (value instanceof Y.Map) {
      for (let item = value._start; item; item = item.right) if (!item.deleted) throw new Error(`Unsupported mixed map in board ${boardId}`);
      for (const [key, child] of value.entries()) entry(key, child);
      return;
    }
    if (value instanceof Y.Array) {
      for (const item of value._map.values()) if (!item.deleted) throw new Error(`Unsupported mixed array in board ${boardId}`);
      for (const child of value.toArray()) visit(child);
      return;
    }
    // Text embeds and XML attributes disappear in toJSON(). Do not turn
    // unsupported historical data into proof that an asset is unreferenced.
    if (value instanceof Y.AbstractType || value instanceof Uint8Array) throw new Error(`Unsupported raw data in board ${boardId}`);
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    // lib0's decoder can move an old __proto__ subtree off the own entries.
    // Reject it instead of mistaking the hidden references for orphaned data.
    if (value && typeof value === 'object') {
      if (!plainRecord(value)) throw new Error(`Unsupported raw object prototype in board ${boardId}`);
      for (const [key, child] of Object.entries(value)) entry(key, child);
    }
  };
  try {
    Y.applyUpdate(doc, update);
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error(`Incomplete document for board ${boardId}`);
    if (!doc.share.has('meta') || doc.getMap('meta').get('schemaVersion') !== SCHEMA_VERSION) throw new Error(`Unsupported document schema for board ${boardId}`);
    for (const name of doc.share.keys()) {
      if (name === 'meta' || name.startsWith(CLOCK_PREFIX)) {
        const root = doc.getMap(name);
        for (let item = root._start; item; item = item.right) if (!item.deleted) throw new Error(`Unsupported document root ${name}`);
        if (name !== 'meta' && clockRootValue(doc, name.slice(CLOCK_PREFIX.length)) === undefined) throw new Error(`Malformed clock root ${name}`);
        visit(root);
      } else if (name.startsWith(WRITER_PREFIX) && name.length > WRITER_PREFIX.length) {
        const root = doc.getArray(name);
        for (const item of root._map.values()) if (!item.deleted) throw new Error(`Unsupported document root ${name}`);
        visit(root);
      } else throw new Error(`Unsupported document root ${name}`);
    }
    return references;
  } finally { doc.destroy(); }
}

/** Offline collection: commit row removal before deleting any unreferenced immutable blob. */
export function gcAssets(store: Store, assetDirectory: string): AssetGCResult {
  const root = safeAssetRoot(store, assetDirectory), lease = acquireMaintenanceLease(store.filename, 'exclusive');
  try {
    const candidates = new Set<string>();
    const removedAssets = store.db.transaction(() => {
      const references = new Set<string>();
      const boards = store.db.prepare('SELECT b.id,d.board_id AS documentId FROM boards b LEFT JOIN documents d ON d.board_id=b.id').all() as { id: string; documentId: string | null }[];
      for (const board of boards) {
        if (!board.documentId) throw new Error(`Missing document for board ${board.id}`);
        const update = store.loadDocument(board.id);
        if (!update) throw new Error(`Missing document for board ${board.id}`);
        for (const id of rawAssetReferences(update, board.id)) references.add(id);
      }
      const rows = store.db.prepare('SELECT id,board_id AS boardId,storage_key AS storageKey FROM assets').all() as { id: string; boardId: string; storageKey: string }[];
      const boardIds = new Set(boards.map(board => board.id)), retainedKeys = new Set(avatarStorageKeys(store.db));
      for (const key of retainedKeys) regularBlob(root, key, true);
      for (const row of rows) {
        if (!boardIds.has(row.boardId)) throw new Error('Asset belongs to an unknown board');
        safeStorageKey(row.storageKey);
        // Safe blob names are ASCII. Conservatively keep all case aliases,
        // including on case-sensitive disks, rather than unlink a live inode.
        if (references.has(row.id)) retainedKeys.add(row.storageKey.toLowerCase());
      }
      for (const row of rows) {
        regularBlob(root, row.storageKey, references.has(row.id));
        if (!retainedKeys.has(row.storageKey.toLowerCase())) candidates.add(row.storageKey);
      }
      // Recover UUID blobs left by interrupted uploads or postcommit deletion
      // failures; never sweep unrelated leaf files such as session-secret.
      for (const name of readdirSync(root)) if (uuidLeaf.test(name) && !retainedKeys.has(name.toLowerCase())) {
        regularBlob(root, name); candidates.add(name);
      }
      const remove = store.db.prepare('DELETE FROM assets WHERE id=?');
      let count = 0;
      for (const row of rows) if (!references.has(row.id)) count += remove.run(row.id).changes;
      return count;
    }).immediate();
    const result: AssetGCResult = { removedAssets, removedBlobs: 0, leftoverBlobs: [] };
    const stillReferenced = store.db.prepare('SELECT 1 FROM assets WHERE storage_key=? COLLATE NOCASE UNION ALL SELECT 1 FROM users WHERE avatar_key=? COLLATE NOCASE LIMIT 1');
    for (const key of candidates) {
      try {
        if (stillReferenced.get(key, key)) continue;
        // Validate again immediately before unlink, after the SQL commit.
        if (regularBlob(root, key)) { unlinkSync(join(root, key)); result.removedBlobs++; }
      } catch { result.leftoverBlobs.push(key); }
    }
    return result;
  } finally { lease.release(); }
}

/** Repair a poisoned element offline without constructing a projection or resetting Yjs clocks. */
export function pruneElement(store: Store, boardId: string, elementId: string): { removedRecords: number } {
  if (!elementId) throw new Error('An element ID is required');
  const snapshot = store.loadDocument(boardId);
  if (!snapshot) throw new Error('Board not found');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot);
    const clockBound = causalClockBound(doc);
    const removals: { records: Y.Array<unknown>; indices: number[] }[] = [];
    let clock = 0, removedRecords = 0;
    for (const name of doc.share.keys()) {
      if (name.startsWith(CLOCK_PREFIX)) { clock = Math.max(clock, clockRootValue(doc, name.slice(CLOCK_PREFIX.length), clockBound) ?? 0); continue; }
      if (!name.startsWith(WRITER_PREFIX)) continue;
      let records: Y.Array<unknown>;
      try { records = doc.getArray(name); } catch { continue; }
      const indices: number[] = [];
      records.toArray().forEach((record, index) => {
        if (!plainRecord(record)) return;
        if (validWriterRecord(record, name.slice(WRITER_PREFIX.length), clockBound)) clock = Math.max(clock, record.val.stamp.clock);
        let keyId: unknown;
        try { const parts: unknown = typeof record.key === 'string' ? JSON.parse(record.key) : undefined; if (Array.isArray(parts)) keyId = parts[0]; } catch { /* Fall back to the base's embedded ID. */ }
        const base = plainRecord(record.val) && plainRecord(record.val.value) ? record.val.value : undefined;
        // A malformed key may still identify its damaged base through element.id.
        if (keyId === elementId || plainRecord(base?.element) && base.element.id === elementId) indices.push(index);
      });
      removals.push({ records, indices }); removedRecords += indices.length;
    }
    if (!removedRecords) throw new Error('Element records not found');
    const actor = String(doc.clientID), stamp = { actor, clock: clock + 1 };
    doc.transact(() => {
      for (const { records, indices } of removals) for (const index of indices.reverse()) records.delete(index, 1);
      doc.getArray(WRITER_PREFIX + actor).push([{ key: JSON.stringify([elementId, '$base']), val: { stamp, value: null } }]);
      doc.getMap(CLOCK_PREFIX + actor).set('value', stamp.clock);
    }, 'prune-element');
    store.compact(boardId, Y.encodeStateAsUpdate(doc));
    return { removedRecords };
  } finally { doc.destroy(); }
}

interface Manifest { version: 1; createdAt: string; files: Record<string, string>; boards: number; assets: number }
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** The SQLite backup API captures a coherent live snapshot. Asset blobs are immutable. */
export async function createBackup(store: Store, assetDirectory: string, sessionSecret: string, destination: string): Promise<Manifest> {
  if (existsSync(destination)) throw new Error('Backup destination must not already exist');
  const root = safeAssetRoot(store, assetDirectory);
  const lease = acquireMaintenanceLease(store.filename, 'shared');
  const staging = `${destination}.partial-${process.pid}`;
  try {
    mkdirSync(join(staging, 'assets'), { recursive: true, mode: 0o700 });
    const database = join(staging, 'whiteboard.sqlite'); await store.backup(database); chmodSync(database, 0o600);
    const snapshot = new Sqlite(database, { readonly: true });
    let keys: { storage_key: string }[], boards: number, assets: number;
    try {
      if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup SQLite integrity check failed');
      // Read both roots from the copied snapshot, never from a profile that
      // may be refreshed while this shared snapshot-and-copy lease is held.
      avatarStorageKeys(snapshot);
      keys = snapshot.prepare('SELECT storage_key FROM assets UNION SELECT avatar_key AS storage_key FROM users WHERE avatar_key IS NOT NULL').all() as { storage_key: string }[];
      boards = (snapshot.prepare('SELECT count(*) AS count FROM boards').get() as { count: number }).count;
      assets = (snapshot.prepare('SELECT count(*) AS count FROM assets').get() as { count: number }).count;
    } finally { snapshot.close(); }
    for (const { storage_key } of keys) regularBlob(root, storage_key, true);
    for (const { storage_key } of keys) copyFileSync(join(root, storage_key), join(staging, 'assets', storage_key));
    writeFileSync(join(staging, 'session-secret'), sessionSecret, { mode: 0o600 });
    const files = ['whiteboard.sqlite', 'session-secret', ...keys.map(key => `assets/${key.storage_key}`)];
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), boards, assets, files: Object.fromEntries(files.map(file => [file, hash(join(staging, file))])) };
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    mkdirSync(dirname(destination), { recursive: true }); renameSync(staging, destination); return manifest;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  finally { lease.release(); }
}

/** Restore is deliberately offline and refuses an existing data directory. */
export function restoreBackup(source: string, destination: string): Manifest {
  if (existsSync(destination)) throw new Error('Restore destination must not already exist');
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || !manifest.files['whiteboard.sqlite'] || !manifest.files['session-secret']) throw new Error('Unsupported backup manifest');
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!/^(whiteboard\.sqlite|session-secret|assets\/[a-zA-Z0-9-]+)$/.test(file) || hash(join(source, file)) !== expected) throw new Error(`Backup verification failed: ${file}`);
  }
  const staging = `${destination}.partial-${process.pid}`;
  mkdirSync(join(staging, 'assets'), { recursive: true, mode: 0o700 });
  try {
    for (const file of Object.keys(manifest.files)) copyFileSync(join(source, file), join(staging, file));
    const database = new Sqlite(join(staging, 'whiteboard.sqlite'));
    try { if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Restored SQLite integrity check failed'); } finally { database.close(); }
    mkdirSync(dirname(destination), { recursive: true }); renameSync(staging, destination); return manifest;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
