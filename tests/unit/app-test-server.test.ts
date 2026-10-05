import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('SIGTERM during real routed fixture startup closes late listeners and removes disposable storage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-fixture-lifecycle-')), preload = join(directory, 'hold-ready.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const mkdtemp=fs.mkdtempSync;
fs.mkdtempSync=function(prefix,...args){const path=mkdtemp.call(this,prefix,...args);if(String(prefix).includes('whiteboard-browser-'))process.send?.({phase:'directory',path});return path;};
syncBuiltinESMExports();
const originalFetch=globalThis.fetch;let released=false;const waiting=[];
globalThis.fetch=async (...args)=>{if(String(args[0]).endsWith('/ready')&&!released){process.send?.({phase:'paused'});await new Promise(resolve=>waiting.push(resolve));}return originalFetch(...args);};
process.on('message',message=>{if(message==='release'){released=true;for(const resolve of waiting)resolve();process.disconnect?.();}});
process.on('SIGTERM',()=>process.send?.({phase:'stopping'}));
`);
  const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as { port: number }).port; await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const child = fork(fileURLToPath(new URL('../../scripts/app-test-server.ts', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), execArgv: ['--import', 'tsx', '--import', preload], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', WHITEBOARD_TEST_GOOGLE: '1', WHITEBOARD_TEST_SHARDS: '2', WHITEBOARD_TEST_PORT: String(port) },
  });
  let fixtureDirectory = '', output = '', exited = false, paused = false, stopping = false;
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  child.on('message', message => { const value = message as { phase: string; path?: string }; if (value.phase === 'directory') fixtureDirectory = value.path!; if (value.phase === 'paused') paused = true; if (value.phase === 'stopping') stopping = true; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  const until = async (check: () => boolean) => { const started = Date.now(); while (!check()) { if (exited || Date.now() - started > 5000) throw new Error('Fixture phase did not arrive: ' + output); await new Promise(resolve => setTimeout(resolve, 5)); } };
  try {
    await until(() => paused); expect(fixtureDirectory).not.toBe(''); expect(existsSync(fixtureDirectory)).toBe(true);
    child.kill('SIGTERM'); await until(() => stopping);
    if (child.connected) child.send('release', () => {});
    await until(() => exited); expect(await exit, output).toEqual({ code: 0, signal: null });
    expect(existsSync(fixtureDirectory)).toBe(false);
    const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  } finally {
    if (!exited) { child.kill('SIGKILL'); await exit; }
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
