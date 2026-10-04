import Sqlite from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface MaintenanceLease { databasePath: string; leasePath: string; release(): void }

/** Database aliases share one lease, including before the first database is created. */
export function canonicalDatabasePath(filename: string): string {
  if (filename === ':memory:') return filename;
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true });
  return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
}

/** A separate DELETE-journal database holds read/exclusive locks without blocking normal WAL writes. */
export function acquireMaintenanceLease(filename: string, mode: 'shared' | 'exclusive'): MaintenanceLease {
  const databasePath = canonicalDatabasePath(filename), leasePath = `${databasePath}.maintenance.sqlite`;
  if (databasePath === ':memory:') {
    if (mode === 'exclusive') throw new Error('Asset maintenance requires a persistent database');
    return { databasePath, leasePath: '', release() {} };
  }
  let initialized = false;
  try {
    const stat = lstatSync(leasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe maintenance lease path');
    initialized = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!initialized) {
    const initialize = new Sqlite(leasePath, { timeout: 0 });
    try {
      initialize.pragma('journal_mode = DELETE');
      initialize.exec('CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK(id=1)); INSERT OR IGNORE INTO maintenance VALUES (1)');
      chmodSync(leasePath, 0o600);
    } finally { initialize.close(); }
  }
  const stat = lstatSync(leasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe maintenance lease path');
  const lease = new Sqlite(leasePath, { timeout: 0 });
  try {
    if (lease.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('Unsupported maintenance lease journal mode');
    lease.exec(mode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN');
    if (!(lease.prepare('SELECT id FROM maintenance WHERE id=1').get())) throw new Error('Invalid maintenance lease database');
  } catch (error) {
    lease.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') throw new Error('Asset maintenance is busy: stop the server and finish backups before GC');
    throw error;
  }
  let released = false;
  return { databasePath, leasePath, release() {
    if (released) return; released = true;
    try { lease.exec('ROLLBACK'); } finally { lease.close(); }
  } };
}
