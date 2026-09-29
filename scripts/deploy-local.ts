import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../packages/server/src/store.js';
import { serverConfig } from '../packages/server/src/config.js';

if (process.platform !== 'darwin') throw new Error('This deployment helper targets the selected Mac. See the server README for other hosts.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticDirectory = join(root, 'packages/app/dist'), baseUrl = 'http://127.0.0.1:3001';
const indexPath = join(staticDirectory, 'index.html');
if (!existsSync(indexPath)) throw new Error('Build the production application first: VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build');
const indexBytes = readFileSync(indexPath), indexHash = hash(indexBytes);
const scripts = [...indexBytes.toString('utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1]!);
if (!scripts.length || scripts.some(path => !/^\/assets\/[a-zA-Z0-9_.-]+\.js$/.test(path))) throw new Error('The production index must reference built local JavaScript assets.');
const assetHashes = new Map(scripts.map(path => [path, hash(readFileSync(join(staticDirectory, path.slice(1))))]));
for (const file of readdirSync(join(staticDirectory, 'assets'))) {
  if (file.endsWith('.js') && readFileSync(join(staticDirectory, 'assets', file), 'utf8').includes('whiteboardConnection')) throw new Error('This is a browser-test build. Rebuild with VITE_TEST_HOOKS=0 before deploying.');
}

const label = 'com.threejs-whiteboard.local', domain = `gui/${process.getuid!()}`, serviceTarget = `${domain}/${label}`;
const dataDirectory = join(homedir(), 'Library/Application Support/ThreejsWhiteboard');
const agents = join(homedir(), 'Library/LaunchAgents'), logs = join(dataDirectory, 'logs'), plistPath = join(agents, `${label}.plist`);
const xml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function command(executable: string, args: string[], timeout = 5000) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout });
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.message}`);
  return result;
}
function service(): { loaded: boolean; running: boolean; pid?: number } {
  const result = command('/bin/launchctl', ['print', serviceTarget]);
  if (result.status !== 0) {
    if (!/could not find service|not found/i.test(result.stderr)) throw new Error(`Cannot inspect the launch agent: ${result.stderr.trim()}`);
    return { loaded: false, running: false };
  }
  const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1];
  return { loaded: true, running: /^\s*state = running\s*$/m.test(result.stdout), ...(pid ? { pid: Number(pid) } : {}) };
}
function processes(): Map<number, number> {
  const result = command('/bin/ps', ['-axo', 'pid=,ppid=']);
  if (result.status !== 0) throw new Error('Cannot inspect process ownership.');
  return new Map(result.stdout.split('\n').flatMap(line => { const fields = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); return fields ? [[Number(fields[1]), Number(fields[2])] as [number, number]] : []; }));
}
function belongsTo(pid: number, parent: number, table: Map<number, number>): boolean {
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) { if (pid === parent) return true; seen.add(pid); pid = table.get(pid) ?? 0; }
  return false;
}
function listeners(): number[] {
  const result = command('/usr/sbin/lsof', ['-nP', '-iTCP:3001', '-sTCP:LISTEN', '-t']);
  if (result.status !== 0 && result.status !== 1) throw new Error('Cannot inspect port 3001.');
  return [...new Set(result.stdout.split('\n').filter(value => /^\d+$/.test(value)).map(Number))];
}
const pause = () => new Promise(resolve => setTimeout(resolve, 250));

// Check ownership and the port before modifying credentials or stopping any process.
if (existsSync(plistPath)) {
  const existing = command('/usr/bin/plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', plistPath]);
  if (existing.status !== 0 || existing.stdout.trim() !== root) throw new Error('A different or unrecognized checkout owns this launch agent; refusing to replace it.');
}
const previous = service(), previousTable = processes();
if (previous.loaded && !existsSync(plistPath)) throw new Error('The loaded launch agent has no matching ownership file; refusing to replace it.');
const previousPids = previous.pid ? [...previousTable.keys()].filter(pid => belongsTo(pid, previous.pid!, previousTable)) : [];
const occupied = listeners();
if (occupied.some(pid => !previous.pid || !belongsTo(pid, previous.pid, previousTable))) throw new Error('Port 3001 belongs to another process. Stop that service or browser-test fixture before deploying.');

mkdirSync(dataDirectory, { recursive: true, mode: 0o700 }); chmodSync(dataDirectory, 0o700);
process.env.WHITEBOARD_DATA_DIR = dataDirectory;
const credentialsPath = join(dataDirectory, 'owner-credentials.json');
let credentials: { username: string; password: string; url: string };
if (existsSync(credentialsPath)) {
  try { credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')); }
  catch { throw new Error('The existing owner credentials file cannot be read as JSON; it has not been replaced.'); }
  if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string' || credentials.password.length < 12 || credentials.url !== baseUrl) throw new Error('The existing owner credentials file is invalid; it has not been replaced.');
} else {
  credentials = { username: 'owner', password: randomBytes(24).toString('base64url'), url: baseUrl };
  writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
chmodSync(credentialsPath, 0o600);
const options = serverConfig(), store = new Store(options.databasePath, options.sessionSecret);
let ownerId: string;
try {
  const user = store.userByName(credentials.username) ?? store.createUser(credentials.username, credentials.password);
  const session = store.login(credentials.username, credentials.password);
  if (!session) throw new Error('The saved credentials do not match the existing owner account; no account password was changed.');
  ownerId = user.id; store.logout(session.sessionId);
} finally { store.close(); }

async function stopOwnedService(): Promise<void> {
  const stopped = command('/bin/launchctl', ['bootout', serviceTarget], 25_000);
  if (stopped.status !== 0) throw new Error(`Could not stop the owned service: ${stopped.stderr.trim()}`);
}
if (previous.loaded) {
  await stopOwnedService();
  const deadline = Date.now() + 25_000;
  while (true) {
    const table = processes(), active = listeners();
    if (active.some(pid => !previousPids.includes(pid))) throw new Error('Another process acquired port 3001 during redeployment.');
    if (!active.length && !previousPids.some(pid => table.has(pid))) break;
    if (Date.now() >= deadline) throw new Error('The previous service did not finish draining; it has not been force-killed.');
    await pause();
  }
}
mkdirSync(agents, { recursive: true }); mkdirSync(logs, { recursive: true, mode: 0o700 });
const environment = { WHITEBOARD_DATA_DIR: dataDirectory, WHITEBOARD_STATIC_DIR: staticDirectory, HOST: '127.0.0.1', PORT: '3001', NODE_ENV: 'production', WHITEBOARD_DRAIN_MS: '5000' };
// Import the TypeScript loader in the server process: launchd owns the actual
// listener PID and sends SIGTERM directly to its five-second drain handler.
const arguments_ = [process.execPath, '--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href, join(root, 'packages/server/src/index.ts')];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${arguments_.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>20</integer>
<key>StandardOutPath</key><string>${xml(join(logs, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'server-error.log'))}</string>
</dict></plist>\n`;
writeFileSync(plistPath, plist, { mode: 0o600 }); chmodSync(plistPath, 0o600);
const valid = command('/usr/bin/plutil', ['-lint', plistPath]);
if (valid.status !== 0) throw new Error('The generated launch-agent configuration is invalid.');
const started = command('/bin/launchctl', ['bootstrap', domain, plistPath]);
if (started.status !== 0) throw new Error(`Could not start the service: ${started.stderr.trim()}`);
const deadline = Date.now() + 20_000;
async function fetchBounded(path: string, init: RequestInit = {}): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Deployment verification timed out.');
  return fetch(`${baseUrl}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(2000, remaining)) });
}
try {
  let pid: number | undefined;
  while (Date.now() < deadline) {
    const current = service(), active = listeners(), table = processes();
    if (active.length && (!current.pid || active.some(id => !belongsTo(id, current.pid!, table)))) throw new Error('Port 3001 is not owned by the launched service.');
    if (current.running && current.pid && active.length) {
      try {
        const response = await fetchBounded('/ready');
        if (response.ok && (await response.json() as { ready?: unknown }).ready === true) { pid = current.pid; break; }
      } catch {}
    }
    await pause();
  }
  if (!pid) throw new Error('The owned service did not become ready.');
  for (const [path, expected] of new Map([['/', indexHash], ...assetHashes])) {
    const response = await fetchBounded(path);
    if (!response.ok || hash(new Uint8Array(await response.arrayBuffer())) !== expected) throw new Error('The service is not serving the exact production build selected for deployment.');
  }
  const login = await fetchBounded('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ username: credentials.username, password: credentials.password }) });
  if (!login.ok) throw new Error('The deployed service rejected the saved owner credentials.');
  const session = await login.json() as { user?: { id?: string; username?: string }; token?: string };
  if (typeof session.token !== 'string') throw new Error('The deployed service returned an invalid session.');
  const logout = await fetchBounded('/api/session/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } });
  if (!logout.ok) throw new Error('Could not revoke the temporary deployment verification session.');
  if (session.user?.id !== ownerId || session.user.username !== credentials.username) throw new Error('The deployed service authenticated a different owner/database.');
  const final = service(), active = listeners(), table = processes();
  if (!final.running || final.pid !== pid || !active.length || active.some(id => !belongsTo(id, pid!, table))) throw new Error('The service restarted or lost its listener during deployment verification.');
  console.log(JSON.stringify({ url: baseUrl, credentialsPath, dataDirectory, plistPath, pid, indexHash }));
} catch (error) {
  // Bootstrap succeeded, so this invocation owns this service. Remove a failed
  // launch instead of leaving KeepAlive in a crash loop; never kill port owners.
  if (service().loaded) await stopOwnedService();
  throw new Error(`${error instanceof Error ? error.message : 'Deployment verification failed.'} Inspect ${join(logs, 'server-error.log')}.`);
}
