import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWhiteboardServer } from '../packages/server/src/server.js';
import { createRouter } from '../packages/server/src/router.js';

// Disposable browser fixture: these accounts and bytes never enter deployment storage.
const directory = mkdtempSync(join(tmpdir(), 'whiteboard-browser-'));
const routed = process.env.WHITEBOARD_TEST_SHARDS === '2';
const options = { databasePath: join(directory, 'test.sqlite'), assetDirectory: join(directory, 'assets'), sessionSecret: randomBytes(40).toString('hex'), port: routed ? 0 : 3001 };
const app = createWhiteboardServer(options);
for (const username of ['alice', 'bob', 'viewer', 'outsider']) app.store.createUser(username, 'browser-test-only-password');
await app.listen();
// Same-host shared SQLite is a test topology; a remote deployment needs its own
// shared transactional storage. Each board still has exactly one live owner.
const second = routed ? createWhiteboardServer(options) : undefined;
await second?.listen();
const router = second ? createRouter([{ id: 'a', url: `http://127.0.0.1:${app.port}` }, { id: 'b', url: `http://127.0.0.1:${second.port}` }], { port: 3001 }) : undefined;
await router?.listen();
console.log('Disposable browser fixture ready on 127.0.0.1:3001');
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await router?.close(); await second?.close(); await app.close(); rmSync(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
