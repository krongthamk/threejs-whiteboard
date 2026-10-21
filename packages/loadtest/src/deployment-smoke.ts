/** Starts ONLY an isolated disposable Compose project. Never targets an existing deployment. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { BoardDocument } from '@whiteboard/model';

if (process.argv[2] !== '--run-isolated-stack') throw new Error('Pass --run-isolated-stack to build and test disposable Docker volumes. Ports 443 and 80 must be available.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'whiteboard-deployment-'));
const project = `whiteboard-verify-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
const envFile = join(temporary, '.env'), overrideFile = join(temporary, 'test.json'), restoreFile = join(temporary, 'restore.json');
const repository = join(temporary, 'repository');
mkdirSync(repository); chmodSync(repository, 0o777); // Disposable encrypted test repository, not a production secret.
const secret = join(temporary, 'password'); writeFileSync(secret, randomBytes(32).toString('hex'), { mode: 0o444 });
const backupEnv = join(temporary, 'backup.env'); writeFileSync(backupEnv, 'RESTIC_REPOSITORY=/repository\n', { mode: 0o600 });
writeFileSync(envFile, `WHITEBOARD_DOMAIN=localhost\nWHITEBOARD_IMAGE=${project}:test\nWHITEBOARD_LOCAL_PORT=3031\nWHITEBOARD_DATA_VOLUME=${project}-data\nWHITEBOARD_RESTORE_VOLUME=${project}-restored\nWHITEBOARD_BACKUP_HOST=${project}\n`);
writeFileSync(overrideFile, JSON.stringify({ services: { backup: {
  env_file: [{ path: backupEnv }], volumes: [`${repository}:/repository`],
} }, secrets: { restic_password: { file: secret } } }));
writeFileSync(restoreFile, JSON.stringify({ services: { app: { volumes: ['restore_data:/data'] } } }));
const base = ['compose', '--project-directory', join(root, 'deploy'), '--env-file', envFile, '-p', project,
  '-f', join(root, 'deploy/compose.yaml'), '-f', overrideFile, '--profile', 'https', '--profile', 'operations'];
let restored = false;
function compose(args: string[], quiet = false, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('docker', [...base, ...(restored ? ['-f', restoreFile] : []), ...args], {
    cwd: root, env, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024,
  });
}
async function until(check: () => boolean | Promise<boolean>, message: string, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${message}`);
}
let ca = '';
type Session = { cookie: string; user: { id: string; username: string; name: string } };
async function request(path: string, options: { method?: string; session?: Session; body?: unknown; bytes?: Buffer; origin?: string } = {}) {
  const body = options.bytes ?? (options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)));
  return new Promise<{ status: number; bytes: Buffer; headers: import('node:http').IncomingHttpHeaders; json(): any }>((resolve, reject) => {
    const req = httpsRequest(`https://localhost${path}`, { ca, method: options.method ?? 'GET', timeout: 10000,
      headers: { Origin: options.origin ?? 'https://localhost', ...(options.session ? { Cookie: options.session.cookie } : {}),
        ...(body ? { 'Content-Length': body.length, 'Content-Type': options.bytes ? 'image/png' : 'application/json' } : {}) },
    }, response => {
      const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(Buffer.from(bytes)));
      response.on('error', reject); response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode!, bytes, headers: response.headers, json: () => JSON.parse(bytes.toString()) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTPS request timed out'))); req.on('error', reject); req.end(body);
  });
}
async function login(username: string): Promise<Session> {
  const response = await request('/api/session', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('board_session='));
  assert(cookie && /; Secure/.test(cookie) && /; HttpOnly/.test(cookie) && /; SameSite=Lax/.test(cookie));
  assert.equal(response.json().token, undefined);
  return { cookie: cookie.split(';', 1)[0]!, user: response.json().user };
}
const clients: (() => void)[] = [];
function closeClients() { for (const close of clients.splice(0)) close(); }
async function connect(boardId: string, session: Session) {
  let failure = '';
  const doc = new Y.Doc();
  class AuthenticatedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols, { ca, headers: { Cookie: session.cookie, Origin: 'https://localhost' } }); }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `wss://localhost/collaboration?expectedUserId=${session.user.id}`, WebSocketPolyfill: AuthenticatedWebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: boardId, token: '', document: doc,
    onAuthenticationFailed: ({ reason }) => { failure = reason; } });
  const board = new BoardDocument(doc, { undo: false });
  clients.push(() => { provider.destroy(); socket.destroy(); board.destroy(); doc.destroy(); });
  provider.attach();
  await until(() => { if (failure) throw new Error(`WebSocket authentication failed: ${failure}`); return provider.isSynced; }, 'WebSocket synchronization');
  return { board, provider };
}
function backup(action: string) { compose(['run', '--rm', '--no-deps', 'backup', action]); }

try {
  console.log('Building the pinned Node LTS image and starting the isolated HTTPS stack.');
  compose(['build', 'app']);
  compose(['up', '-d', '--wait', '--wait-timeout', '180', 'app', 'proxy']);
  await until(() => {
    try { ca = compose(['exec', '-T', 'proxy', 'cat', '/data/caddy/pki/authorities/local/root.crt'], true); return ca.includes('BEGIN CERTIFICATE'); }
    catch { return false; }
  }, 'local test CA');
  await until(async () => { try { return (await request('/ready')).status === 200; } catch { return false; } }, 'HTTPS readiness');
  assert.equal((await request('/api/boards')).status, 401);
  assert.equal((await request('/api/config')).json().googleSignIn, false);
  const html = await request('/'); assert.equal(html.status, 200); assert(html.headers['content-security-policy']);
  const scriptPath = /src="([^"]+\.js)"/.exec(html.bytes.toString())?.[1]; assert(scriptPath);
  assert(!(await request(scriptPath)).bytes.includes(Buffer.from('whiteboardConnection')));
  for (const username of ['deployment-owner', 'deployment-editor', 'deployment-viewer']) {
    compose(['exec', '-T', '-e', 'WHITEBOARD_PASSWORD', 'app', 'node', '--import', 'tsx', 'packages/server/src/provision.ts', username], true,
      { ...process.env, WHITEBOARD_PASSWORD: password });
  }
  const owner = await login('deployment-owner'), editor = await login('deployment-editor'), viewer = await login('deployment-viewer');
  assert.equal((await request('/api/boards', { method: 'POST', session: owner, origin: 'https://untrusted.invalid', body: { title: 'Forbidden' } })).status, 403);
  const created = await request('/api/boards', { method: 'POST', session: owner, body: { title: 'Deployment recovery probe' } });
  assert.equal(created.status, 201); const boardId = created.json().board.id as string;
  for (const [session, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    assert.equal((await request(`/api/boards/${boardId}/members`, { method: 'POST', session: owner, body: { username: session.user.username, role } })).status, 204);
  }
  assert.equal((await request(`/api/boards/${boardId}`, { method: 'PATCH', session: viewer, body: { title: 'Forbidden' } })).status, 403);
  const a = await connect(boardId, owner), b = await connect(boardId, editor), c = await connect(boardId, viewer);
  a.board.create('rect', { id: 'deployment-shape', x: 20, y: 30, w: 120, h: 80 });
  await until(() => b.board.read('deployment-shape')?.x === 20 && c.board.read('deployment-shape')?.x === 20, 'owner update reaches editor and viewer');
  b.board.update('deployment-shape', { x: 160 });
  await until(() => a.board.read('deployment-shape')?.x === 160 && c.board.read('deployment-shape')?.x === 160, 'editor update converges');
  b.provider.awareness!.setLocalState({ userId: editor.user.id, name: editor.user.name, cursor: { x: 42, y: 84 }, selection: [] });
  await until(() => [...a.provider.awareness!.getStates().values()].some(state => state.userId === editor.user.id && state.cursor?.x === 42), 'authenticated presence');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const image = await request(`/api/boards/${boardId}/assets`, { method: 'POST', session: owner, bytes: png });
  assert.equal(image.status, 201); const asset = image.json();
  a.board.create('image', { id: 'deployment-image', x: 0, y: 0, w: 1, h: 1, props: { assetId: asset.assetId, naturalW: 1, naturalH: 1 } });
  await until(() => b.board.read('deployment-image') !== undefined, 'image reference synchronization');
  closeClients();
  compose(['restart', 'app']);
  await until(async () => { try { return (await request('/ready')).status === 200; } catch { return false; } }, 'readiness after restart');
  assert.equal((await request('/api/session', { session: owner })).status, 200);
  const afterRestart = await connect(boardId, owner);
  assert.equal(afterRestart.board.read('deployment-shape')?.x, 160);
  assert.deepEqual((await request(asset.url, { session: owner })).bytes, png);
  console.log('HTTPS, secure sessions, permissions, WSS collaboration/presence, image persistence and graceful restart passed.');

  assert.throws(() => compose(['run', '--rm', '--no-deps', 'backup', 'status'], true), 'missing backups must fail freshness checks');
  backup('init'); backup('backup'); backup('verify'); backup('status');
  afterRestart.board.create('rect', { id: 'after-backup', x: 99, y: 99 });
  const observer = await connect(boardId, editor);
  await until(() => observer.board.read('after-backup') !== undefined, 'post-backup edit');
  backup('restore');
  assert.throws(() => compose(['run', '--rm', '--no-deps', 'backup', 'restore'], true), 'restore must refuse an existing recovery directory');
  assert(afterRestart.board.read('after-backup'), 'restore must not replace live data');
  closeClients();
  restored = true;
  compose(['up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '120', 'app']);
  const recovered = await connect(boardId, owner);
  assert.equal(recovered.board.read('deployment-shape')?.x, 160);
  assert.equal(recovered.board.read('after-backup'), undefined);
  assert.deepEqual((await request(asset.url, { session: owner })).bytes, png);
  assert.equal((await request(`/api/boards/${boardId}/members`, { session: viewer })).status, 200);
  closeClients();
  assert.equal((await request('/api/session', { method: 'DELETE', session: owner })).status, 204);
  assert.equal((await request('/api/session', { session: owner })).status, 401);
  console.log('Encrypted backup, retention, verified remote restore, recovered sessions/memberships/assets/document and logout passed.');
} catch (error) {
  try { console.error(compose(['logs', '--no-color', '--tail', '100', 'app', 'proxy'], true)); } catch {}
  throw error;
} finally {
  closeClients(); restored = false;
  try {
    // Restic created these disposable files as container UID 1000; let that UID
    // remove them so a differently numbered host CI user can clean its temp dir.
    try { compose(['run', '--rm', '--no-deps', '--entrypoint', 'sh', 'backup', '-c', 'rm -rf /repository/*'], true); } catch {}
    compose(['down', '--volumes', '--remove-orphans'], true);
  }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
