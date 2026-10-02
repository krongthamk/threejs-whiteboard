import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../packages/app/dist/', import.meta.url));
const leaked = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (entry.isFile() && readFileSync(path).includes(Buffer.from('whiteboardConnection'))) leaked.push(path);
  }
}
inspect(directory);
if (leaked.length) {
  console.error(`Production build exposes whiteboardConnection test hooks:\n${leaked.join('\n')}`);
  process.exitCode = 1;
} else console.log('Production build contains no whiteboardConnection test hook.');
