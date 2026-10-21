import { statfsSync } from 'node:fs';

const stats = statfsSync(process.env.WHITEBOARD_DATA_DIR ?? '/data/live');
const freeBytes = stats.bavail * stats.bsize;
if (stats.blocks === 0 || stats.bavail / stats.blocks < 0.1 || freeBytes < 1024 ** 3 || stats.files > 0 && stats.ffree / stats.files < 0.1) {
  console.error('Whiteboard data storage is low: keep at least 10% free space/inodes and 1 GiB available.');
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: 'storage-ok', freeBytes }));
