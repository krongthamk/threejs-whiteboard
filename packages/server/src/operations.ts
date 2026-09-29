import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from './store.js';

interface Manifest { version: 1; createdAt: string; files: Record<string, string>; boards: number; assets: number }
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** The SQLite backup API captures a coherent live snapshot. Asset blobs are immutable. */
export async function createBackup(store: Store, assetDirectory: string, sessionSecret: string, destination: string): Promise<Manifest> {
  if (existsSync(destination)) throw new Error('Backup destination must not already exist');
  const staging = `${destination}.partial-${process.pid}`;
  mkdirSync(join(staging, 'assets'), { recursive: true, mode: 0o700 });
  try {
    const database = join(staging, 'whiteboard.sqlite'); await store.backup(database);
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
