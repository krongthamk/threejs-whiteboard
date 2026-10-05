import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWhiteboardServer } from '../packages/server/src/server.js';
import { createRouter } from '../packages/server/src/router.js';
import { GOOGLE_TEST_EMAIL, startFakeGoogleProvider } from './fake-google-provider.js';

// Disposable browser fixture: these accounts and bytes never enter deployment storage.
const routed = process.env.WHITEBOARD_TEST_SHARDS === '2';
const testPort = Number(process.env.WHITEBOARD_TEST_PORT ?? 3001);
if (!Number.isInteger(testPort) || testPort < 1 || testPort > 65535) throw new Error('WHITEBOARD_TEST_PORT must be an integer from 1 to 65535.');
if (process.env.WHITEBOARD_TEST_GOOGLE === '1' && process.env.NODE_ENV !== 'test') throw new Error('Google browser fixture requires NODE_ENV=test.');
const directory = mkdtempSync(join(tmpdir(), 'whiteboard-browser-'));
function testLimit(name: string): number | undefined {
  const raw = process.env[name]; if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}
let app: ReturnType<typeof createWhiteboardServer> | undefined, second: typeof app, router: ReturnType<typeof createRouter> | undefined;
let google: Awaited<ReturnType<typeof startFakeGoogleProvider>> | undefined;
let closing: Promise<void> | undefined;
function close() {
  return closing ??= (async () => {
    // Signals can arrive while a listen/refresh is pending. Register every
    // acquired resource before cleanup, so startup cannot outlive its owner.
    await startup.catch(() => {});
    let failure: unknown;
    for (const stop of [() => router?.close(), () => second?.close(), () => app?.close(), () => google?.close()]) {
      try { await stop(); } catch (error) { failure ??= error; }
    }
    rmSync(directory, { recursive: true, force: true }); if (failure) throw failure;
  })();
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
const startup = (async () => {
  google = process.env.WHITEBOARD_TEST_GOOGLE === '1' ? await startFakeGoogleProvider() : undefined;
  const options = { databasePath: join(directory, 'test.sqlite'), assetDirectory: join(directory, 'assets'), sessionSecret: randomBytes(40).toString('hex'), port: routed ? 0 : testPort,
    maxUpdateBytes: testLimit('WHITEBOARD_TEST_MAX_UPDATE_BYTES'), maxInboundBytes: testLimit('WHITEBOARD_TEST_MAX_INBOUND_BYTES'), google: google?.config };
  app = createWhiteboardServer(options);
  for (const username of ['alice', 'bob', 'viewer', 'outsider']) app.store.createUser(username, 'browser-test-only-password');
  if (google) app.store.createExternalUser(GOOGLE_TEST_EMAIL);
  await app.listen();
  // Same-host shared SQLite is a test topology; a remote deployment needs its own
  // shared transactional storage. Each board still has exactly one live owner.
  second = routed ? createWhiteboardServer(options) : undefined;
  await second?.listen();
  router = second ? createRouter([{ id: 'a', url: `http://127.0.0.1:${app.port}` }, { id: 'b', url: `http://127.0.0.1:${second.port}` }], { port: testPort }) : undefined;
  await router?.listen();
  console.log(`Disposable browser fixture ready on 127.0.0.1:${testPort}`);
})();
try { await startup; } catch (error) { await close(); throw error; }
