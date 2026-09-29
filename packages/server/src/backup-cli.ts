import { resolve } from 'node:path';
import { serverConfig } from './config.js';
import { Store } from './store.js';
import { createBackup, restoreBackup } from './operations.js';

const [mode, source, target] = process.argv.slice(2);
if (mode === 'backup' && source) {
  const config = serverConfig(), store = new Store(config.databasePath, config.sessionSecret);
  try { const manifest = await createBackup(store, config.assetDirectory, config.sessionSecret, resolve(source)); console.log(JSON.stringify({ event: 'backup-complete', destination: resolve(source), boards: manifest.boards, assets: manifest.assets })); }
  finally { store.close(); }
} else if (mode === 'restore' && source && target) {
  const manifest = restoreBackup(resolve(source), resolve(target)); console.log(JSON.stringify({ event: 'restore-complete', destination: resolve(target), boards: manifest.boards, assets: manifest.assets }));
} else throw new Error('Usage: operations backup <new-directory> | operations restore <backup-directory> <new-data-directory>');
