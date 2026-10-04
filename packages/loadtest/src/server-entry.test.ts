import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { captureSourceInputs, freezeSourceInputs, repositoryRoot } from './source-inputs.js';

type Packet = { type: string; port?: number; pid?: number; documents?: unknown[]; elapsedMs?: number; cpuPctOneCore?: number; changes?: number };

it('production server sources contain no experimental process entry points', () => {
  for (const name of ['spike.ts', 'spike-writer-kv.ts', 'benchmark.ts']) {
    expect(existsSync(join(repositoryRoot, 'packages/server/src', name))).toBe(false);
    expect(existsSync(join(repositoryRoot, 'packages/loadtest/src', name))).toBe(true);
  }
});

/** Only one idle server child: no coordinator, client, or workload is imported. */
async function checkServer(entry: string, directory: string, traceModel = false): Promise<void> {
  const child = fork(entry, [], { execArgv: ['--import', 'tsx'],
    env: { ...process.env, SPIKE_PORT: '0', BENCHMARK_DATA_DIR: join(directory, 'storage'), ...(traceModel ? { NODE_DEBUG: 'esm' } : {}) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stderr!.on('data', bytes => { diagnostics += String(bytes); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  async function packet(type: string, send = true): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`${type} IPC timeout: ${diagnostics.slice(-2000)}`)), 5000);
      const onMessage = (value: unknown) => {
        if (value && typeof value === 'object' && 'type' in value && value.type === type) finish(undefined, value as Packet);
      };
      const onExit = () => finish(new Error(`Child exited before ${type}: ${diagnostics.slice(-2000)}`));
      const onError = (error: Error) => finish(error);
      function finish(error?: Error, result?: Packet) {
        clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
        if (error) reject(error); else resolve(result!);
      }
      child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
      if (send) child.send({ type }, error => { if (error) finish(error); });
    });
  }
  async function boundedExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Child did not exit within 3 seconds')), 3000); })]); }
    finally { clearTimeout(timeout); }
  }
  try {
    const ready = await packet('ready', false);
    expect(ready.port).toBeGreaterThan(0); expect(ready.pid).toBe(child.pid);
    const sample = await packet('sample');
    expect(sample.elapsedMs).toBeGreaterThan(0); expect(Number.isFinite(sample.cpuPctOneCore)).toBe(true); expect(sample.changes).toBe(0);
    await packet('reset'); expect((await packet('sample')).changes).toBe(0);
    expect((await packet('snapshot')).documents).toEqual([]);
    child.send({ type: 'stop' }); expect(await boundedExit()).toEqual({ code: 0, signal: null });
    if (traceModel) {
      const frozenRoot = dirname(dirname(dirname(dirname(entry))));
      const capturedIndex = pathToFileURL(join(frozenRoot, 'packages/model/src/index.ts')).href;
      expect(diagnostics).toContain(capturedIndex);
      expect(diagnostics).not.toContain(pathToFileURL(join(realpathSync(repositoryRoot), 'packages/model/src/index.ts')).href);
      const output = join(repositoryRoot, 'test-results/verification/relocation29'); mkdirSync(output, { recursive: true });
      writeFileSync(join(output, `frozen-${entry.endsWith('benchmark.ts') ? 'production' : 'writer'}-model-trace.log`), diagnostics);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try { await boundedExit(); } catch { child.kill('SIGKILL'); await boundedExit(); }
    }
  }
}

for (const entry of ['spike.ts', 'spike-writer-kv.ts', 'benchmark.ts']) {
  it(`relocated ${entry} supports bounded standalone IPC and clean stop`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'whiteboard-server-entry-'));
    try { await checkServer(fileURLToPath(new URL(entry, import.meta.url)), directory); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const production of [false, true]) {
  it(`captured ${production ? 'production' : 'writer'} sources include every relative import`, () => {
    const inputs = captureSourceInputs(production);
    expect(inputs['spikes/package.json']).toBeTruthy(); expect(inputs['packages/loadtest/src/source-inputs.ts']).toBeTruthy();
    if (production) expect(inputs['packages/server/src/update-limits.ts']).toBeTruthy();
    for (const [path, content] of Object.entries(inputs)) {
      if (!path.endsWith('.ts')) continue;
      const imports = [...content.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)];
      for (const match of imports) {
        const resolved = normalize(join(dirname(path), match[1]!.replace(/\.js$/, '.ts')));
        expect(inputs[resolved], `${path} imports uncaptured ${resolved}`).toBeDefined();
      }
    }
  });
  it(`frozen ${production ? 'production' : 'writer'} child loads captured model source and stops cleanly`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'whiteboard-frozen-entry-'))), frozenRoot = join(directory, 'frozen');
    try {
      freezeSourceInputs(captureSourceInputs(production), frozenRoot);
      expect(realpathSync(join(frozenRoot, 'spikes/node_modules/@whiteboard/model'))).toBe(join(frozenRoot, 'packages/model'));
      expect(readFileSync(join(frozenRoot, 'packages/loadtest/src/source-inputs.ts'), 'utf8')).toContain('captureSourceInputs');
      await checkServer(join(frozenRoot, `packages/loadtest/src/${production ? 'benchmark' : 'spike-writer-kv'}.ts`), directory, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
