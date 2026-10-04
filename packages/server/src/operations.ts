import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from './store.js';
import * as Y from 'yjs';
import { CLOCK_PREFIX, clockRootValue, WRITER_PREFIX, plainRecord, causalClockBound, validWriterRecord } from '../../model/src/document-validation.js';

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
  const staging = `${destination}.partial-${process.pid}`;
  mkdirSync(join(staging, 'assets'), { recursive: true, mode: 0o700 });
  try {
    const database = join(staging, 'whiteboard.sqlite'); await store.backup(database); chmodSync(database, 0o600);
    const snapshot = new Sqlite(database, { readonly: true });
    let keys: { storage_key: string }[], boards: number, assets: number;
    try {
      if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup SQLite integrity check failed');
      keys = snapshot.prepare('SELECT DISTINCT storage_key FROM assets').all() as { storage_key: string }[];
      boards = (snapshot.prepare('SELECT count(*) AS count FROM boards').get() as { count: number }).count;
      assets = (snapshot.prepare('SELECT count(*) AS count FROM assets').get() as { count: number }).count;
    } finally { snapshot.close(); }
    for (const { storage_key } of keys) copyFileSync(join(assetDirectory, storage_key), join(staging, 'assets', storage_key));
    writeFileSync(join(staging, 'session-secret'), sessionSecret, { mode: 0o600 });
    const files = ['whiteboard.sqlite', 'session-secret', ...keys.map(key => `assets/${key.storage_key}`)];
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), boards, assets, files: Object.fromEntries(files.map(file => [file, hash(join(staging, file))])) };
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    mkdirSync(dirname(destination), { recursive: true }); renameSync(staging, destination); return manifest;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
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
