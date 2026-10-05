import { afterEach, expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store';

const secret = 'cross-connection-store-secret-at-least-32-characters', paths: string[] = [], stores: Store[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  for (const store of stores.splice(0)) store.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() { const path = mkdtempSync(join(tmpdir(), 'whiteboard-store-concurrency-')); paths.push(path); return path; }
function worker(directory: string, filename: string, action: string) {
  const program = join(directory, 'worker-' + children.length + '.mjs');
  writeFileSync(program, `import {Store} from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
process.send({type:'ready'}); process.once('message', () => {
 let store; try { store=new Store(${JSON.stringify(filename)},${JSON.stringify(secret)}); const result=(${action}); store.close();store=undefined; process.send({type:'result',result},()=>process.exit(0)); }
 catch(error){ if(store)store.close(); process.send({type:'error',error:String(error)},()=>process.exit(1)); }
});`);
  const child = fork(program, { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
  const messages: any[] = []; let output = ''; child.stderr?.on('data', data => { output = (output + data).slice(-4000); }); child.on('message', message => messages.push(message));
  async function event(type: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = messages.find(message => message.type === type); if (found) return found;
      if (child.exitCode !== null || messages.some(message => message.type === 'error')) throw Error(JSON.stringify(messages) + output);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('Bounded Store child did not emit ' + type + output);
  }
  return { child, event };
}
async function together(workers: ReturnType<typeof worker>[]) {
  await Promise.all(workers.map(w => w.event('ready'))); for (const w of workers) w.child.send('go');
  return Promise.all(workers.map(w => w.event('result')));
}
test('two real constructors migrate the same immutable legacy copy once without dropping dependent data', async () => {
  const path = directory(), filename = join(path, 'whiteboard.sqlite');
  copyFileSync(fileURLToPath(new URL('../test/fixtures/schema2-pre-f1.sqlite', import.meta.url)), filename);
  const action = `({version:store.db.pragma('user_version',{simple:true}),users:store.db.prepare('SELECT count(*) AS n FROM users').get().n,fks:store.db.pragma('foreign_key_check')})`;
  const result = await together([worker(path, filename, action), worker(path, filename, action)]);
  expect(result.map(value => value.result)).toEqual([{ version: 1, users: 3, fks: [] }, { version: 1, users: 3, fks: [] }]);
});
test('concurrent identity callbacks across real connections converge to one user and subject', async () => {
  const path = directory(), filename = join(path, 'whiteboard.sqlite'), store = new Store(filename, secret); stores.push(store);
  const action = `store.resolveExternalIdentity({provider:'google',subject:'same-subject',email:'shared@example.com',displayName:'Shared'}).id`;
  const result = await together([worker(path, filename, action), worker(path, filename, action)]);
  expect(result[0]!.result).toBe(result[1]!.result); expect(store.db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 }); expect(store.db.prepare('SELECT count(*) AS n FROM identities').get()).toEqual({ n: 1 });
});
test('browser-bound state is consumed exactly once across two real SQLite connections', async () => {
  const path = directory(), filename = join(path, 'whiteboard.sqlite'), store = new Store(filename, secret); stores.push(store);
  const record = { state: 's'.repeat(43), nonce: 'n'.repeat(43), verifier: 'v'.repeat(43), browserBindingHash: 'a'.repeat(64), returnPath: '/board/current', expiresAt: Date.now() + 600000 }; store.createOAuthState(record);
  const action = `store.consumeOAuthState(${JSON.stringify(record.state)},${JSON.stringify(record.browserBindingHash)})`;
  const result = await together([worker(path, filename, action), worker(path, filename, action)]);
  expect(result.filter(value => value.result !== null)).toHaveLength(1); expect(result.find(value => value.result !== null)?.result).toEqual(record);
  expect(store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
});
