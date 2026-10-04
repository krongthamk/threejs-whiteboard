import { fork, spawn as launchProcess, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { captureSourceInputs, freezeSourceInputs, repositoryRoot } from './source-inputs.js';

const production = process.env.PRODUCTION === '1';
const port = production ? '12347' : '12346';
const durationSeconds = Number(process.env.DURATION_SECONDS ?? 1800);
const stem = fileURLToPath(new URL(`../results/s3-${production ? 'production' : 'writer'}-${new Date().toISOString().replaceAll(':', '-')}`, import.meta.url));
mkdirSync(dirname(stem), { recursive: true });
const record = (value: object) => appendFileSync(`${stem}.ndjson`, `${JSON.stringify(value)}\n`);
const sourceInputs = captureSourceInputs(production);
const sourceHashes = Object.fromEntries(Object.entries(sourceInputs).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')]));
writeFileSync(`${stem}.sources.json`, JSON.stringify({ sha256: sourceHashes, sources: sourceInputs }, null, 2));
record({ type: 'source-hashes', at: Date.now(), sha256: sourceHashes });
const frozenRoot = `${stem}.inputs`;
freezeSourceInputs(sourceInputs, frozenRoot);
const sleepGuard = process.platform === 'darwin' ? launchProcess('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : undefined;
sleepGuard?.unref();
record({ type: 'runtime', coordinatorPid: process.pid, frozenRoot, sleepGuardPid: sleepGuard?.pid, maximumSchedulerGapMs: 1000, sampleTimeoutMs: 10000 });
type Process = { child: ChildProcess; events: Map<string, any>; exited: boolean };
const samples: any[] = [];
function spawn(path: string, env: Record<string, string>, heap = 1024): Process {
  const child = fork(join(frozenRoot, relative(repositoryRoot, fileURLToPath(new URL(path, import.meta.url)))), [], { execArgv: [`--max-old-space-size=${heap}`, '--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, ...env } });
  const state: Process = { child, events: new Map(), exited: false };
  child.on('message', (message: any) => {
    state.events.set(message.type, message);
    if (message.type === 'sample') samples.push(message);
    const { sessionToken: _secret, ...publicMessage } = message;
    record(publicMessage);
  });
  child.on('exit', (code, signal) => { state.exited = true; record({ type: 'process-exit', pid: child.pid, code, signal }); });
  child.on('error', error => { state.events.set('failed', { error: error.message }); });
  return state;
}
function waitUntil(check: () => boolean, timeout: number): Promise<void> {
  const start = performance.now();
  return new Promise((resolveWait, reject) => {
    const timer = setInterval(() => { if (check()) { clearInterval(timer); resolveWait(); } else if (performance.now() - start > timeout) { clearInterval(timer); reject(new Error('Coordinator timeout')); } }, 20);
  });
}
async function event(process: Process, type: string, timeout = 60000): Promise<any> {
  await waitUntil(() => process.events.has(type) || process.events.has('failed') || process.exited, timeout);
  if (process.events.has(type)) return process.events.get(type);
  throw new Error(`Process ${process.child.pid} failed before ${type}: ${JSON.stringify(process.events.get('failed'))}`);
}
async function request(process: Process, type: string, timeout = 60000): Promise<any> { process.events.delete(type); process.child.send({ type }); return event(process, type, timeout); }
const server = spawn(production ? './benchmark.ts' : './spike-writer-kv.ts', { SPIKE_PORT: port, BENCHMARK_DATA_DIR: `${stem}.storage` });
const workers: Process[] = [];
let sampling: ReturnType<typeof setInterval> | undefined, progress: ReturnType<typeof setInterval> | undefined;
let startedAt = 0;
try {
  const ready = await event(server, 'ready');
  for (let index = 0; index < 8; index++) workers.push(spawn(production ? './production-client-worker.ts' : './writer-client-worker.ts', { SPIKE_PORT: port, BOARD_ID: ready.boardId ?? '', SESSION_TOKEN: ready.sessionToken ?? '', WORKER_INDEX: String(index), DURATION_SECONDS: String(durationSeconds), RESULT_STEM: stem }));
  await Promise.all(workers.map(worker => event(worker, 'connected')));
  workers.forEach(worker => worker.child.send({ type: 'initialize' }));
  await Promise.all(workers.map(worker => event(worker, 'initialized')));
  await request(server, 'reset');
  startedAt = Date.now() + 1000;
  const configuration = { type: 'start', startedAt, durationSeconds, clientCount: 40, clientProcesses: 8, clientsPerProcess: 5, opsPerSecond: 5, cursorHz: 20, serverPid: ready.pid,
    model: `${production ? 'Production BoardDocument' : 'WriterBoardDocument'}, default same-transaction clock ledger, undo:false`, workload: '1280 bounded elements; 60% 48-point pressure stroke replacement, 20% x/y movement, 20% recolor; complete model styles and stamped field/base records',
  };
  record(configuration); console.log(JSON.stringify({ event: 'started', stem, ...configuration }));
  workers.forEach(worker => worker.child.send({ type: 'start', startedAt }));
  await new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, startedAt - Date.now())));
  let samplePending = false, sampleRequest: Promise<void> | undefined;
  sampling = setInterval(() => {
    if (samplePending || !server.child.connected) return;
    samplePending = true;
    sampleRequest = request(server, 'sample', 10000).then(() => {}).catch(error => { server.events.set('failed', { error: `Sample deadline missed: ${String(error)}` }); }).finally(() => { samplePending = false; });
  }, 5000);
  progress = setInterval(() => {
    const current = workers.map(worker => worker.events.get('worker-sample')).filter(Boolean);
    console.log(JSON.stringify({ event: 'progress', elapsedSeconds: (Date.now() - startedAt) / 1000, operations: current.reduce((sum, worker) => sum + worker.operations, 0), acknowledged: current.reduce((sum, worker) => sum + worker.acknowledged, 0), latestSample: samples.at(-1) }));
  }, 60000);
  await waitUntil(() => server.events.has('failed') || server.exited || workers.some(worker => worker.events.has('failed') || worker.exited) || workers.every(worker => worker.events.has('done')), durationSeconds * 1000 + 90000);
  clearInterval(sampling); clearInterval(progress);
  await sampleRequest;
  if (server.events.has('failed') || server.exited || !workers.every(worker => worker.events.has('done'))) throw new Error(`Workload could not complete: ${JSON.stringify(server.events.get('failed') ?? workers.find(worker => worker.events.has('failed'))?.events.get('failed') ?? 'process exited')}`);
  const results = workers.map(worker => worker.events.get('done'));
  await request(server, 'sample');
  const snapshot = await request(server, 'snapshot');
  const endedAt = Math.max(...results.map(worker => worker.endedAt));
  const measuredSeconds = (endedAt - startedAt) / 1000;
  const latencies = results.flatMap(worker => {
    const bytes = readFileSync(worker.latencyFile);
    return Array.from({ length: bytes.length / 8 }, (_, index) => bytes.readDoubleLE(index * 8));
  }).sort((a, b) => a - b);
  const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;
  const total = (field: string) => results.reduce((sum, worker) => sum + worker[field], 0);
  const traffic = Object.fromEntries(Object.keys(results[0].traffic).map(key => [key, results.reduce((sum, worker) => sum + worker.traffic[key], 0)]));
  const warm = samples.filter(sample => sample.at >= startedAt + 300000);
  function slope(field: string): number {
    const selected = warm.length > 1 ? warm : samples;
    const x = selected.map(sample => (sample.at - startedAt) / 60000), y = selected.map(sample => sample[field] / 1048576);
    const mx = x.reduce((sum, value) => sum + value, 0) / x.length, my = y.reduce((sum, value) => sum + value, 0) / y.length;
    return x.reduce((sum, value, index) => sum + (value - mx) * (y[index]! - my), 0) / x.reduce((sum, value) => sum + (value - mx) ** 2, 0);
  }
  const hashes = results.flatMap(worker => worker.hashes);
  const converged = snapshot.documents.length === 1 && hashes.length === 40 && hashes.every(hash => hash === snapshot.documents[0].hash);
  const rssSlope = slope('rss'), heapSlope = slope('heapUsed');
  const summary = { startedAt, endedAt, measuredSeconds, hardware: ready.hardware, serverPid: ready.pid, sourceHashes,
    config: { durationSeconds, clientCount: 40, clientProcesses: 8, clientsPerProcess: 5, opsPerSecond: 5, cursorHz: 20, boundedElements: 1280, production, model: configuration.model },
    operations: total('operations'), acknowledged: total('acknowledged'), cursorUpdates: total('cursorUpdates'), documentUpdates: total('documentUpdates'), documentAcknowledgements: total('documentAcknowledgements'), disconnects: total('disconnects'),
    maxSchedulerLagMs: Math.max(...results.map(worker => worker.maxSchedulerLagMs)),
    actualOpsPerClientPerSecond: total('operations') / 40 / measuredSeconds, actualCursorsPerClientPerSecond: total('cursorUpdates') / 40 / measuredSeconds,
    roundTripMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), p99: quantile(latencies, 0.99), max: latencies.at(-1) },
    cpuPctOneCore: { mean: samples.reduce((sum, sample) => sum + sample.cpuPctOneCore, 0) / samples.length, p95: quantile(samples.map(sample => sample.cpuPctOneCore), 0.95), max: Math.max(...samples.map(sample => sample.cpuPctOneCore)) },
    memory: { firstRss: samples[0]?.rss, lastRss: samples.at(-1)?.rss, peakRss: Math.max(...samples.map(sample => sample.rss)), rssSlopeMiBPerMinuteAfterWarmup: rssSlope, heapSlopeMiBPerMinuteAfterWarmup: heapSlope, warmupSeconds: warm.length > 1 ? 300 : 0 },
    traffic: { ...traffic, sentBytesPerSecond: traffic.sentBytes! / measuredSeconds, receivedBytesPerSecond: traffic.receivedBytes! / measuredSeconds, awarenessMessagesPerSecond: traffic.awarenessSent! / measuredSeconds },
    converged, snapshot, clientHashes: hashes, samples, workers: results,
    gate: { duration: measuredSeconds >= 1800, workload: total('operations') === durationSeconds * 40 * 5 && total('cursorUpdates') === durationSeconds * 40 * 20,
      latency: quantile(latencies, 0.95) < 150, cpu: samples.every(sample => sample.cpuPctOneCore < 70),
      memory: measuredSeconds >= 1800 && Math.abs(rssSlope) < 1 && Math.abs(heapSlope) < 1,
      acknowledgements: total('operations') === latencies.length && total('documentUpdates') === total('documentAcknowledgements') && total('disconnects') === 0,
      persistence: !production || snapshot.documents.every((document: any) => document.persistenceMatches),
      serverObservedWorkload: samples.at(-1)?.changes === total('documentUpdates') && samples.at(-1)?.awarenessMessages >= total('cursorUpdates'), converged },
    methodology: { roundTrip: 'Gesture start until every generated provider document update is successfully acknowledged by SyncStatus, including clock ledger writes.', cpu: 'Dedicated child server process user+system CPU delta, percentage of one logical core; first sample includes one-second scheduled-start idle period.', memory: 'Five-second RSS, used heap, and retained/deleted struct samples. After five-minute warmup both RSS and used-heap slopes must be below 1 MiB/min in absolute value, with raw structural trace reviewed.', traffic: 'Aggregate WebSocket application payload bytes, excluding TCP/TLS/frame headers.', clients: '8 processes each hold 5 full independent Y.Doc/provider/socket clients, each 1 GiB V8 heap cap. Server is a ninth isolated process. Distributed client heaps avoid the failed baseline single-heap GC bottleneck without reducing workload.', target: 'User-selected Apple M1 Pro Mac; local network path.', limitations: 'Fixed 40 writer identities. This does not establish bounded storage under indefinitely accumulating new/offline writer identities; no identity reset or retirement is performed.' },
  };
  const bytes = Buffer.allocUnsafe(latencies.length * 8); latencies.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  writeFileSync(`${stem}.latencies.f64le`, bytes); writeFileSync(`${stem}.json`, JSON.stringify(summary, null, 2));
  record({ type: 'complete', ...summary, samples: undefined, workers: undefined });
  console.log(JSON.stringify({ event: 'complete', stem, ...summary, samples: undefined, workers: undefined, clientHashes: undefined, snapshot: undefined }));
} catch (error) {
  const failure = { status: 'failed', error: error instanceof Error ? error.message : String(error), startedAt, failedAt: Date.now(), samples,
    workers: workers.map(worker => worker.events.get('failed') ?? worker.events.get('done') ?? worker.events.get('worker-sample')), note: 'Worker binary latency checkpoints and NDJSON preserve partial observations. No successful completion or convergence is claimed.' };
  writeFileSync(`${stem}.failure.json`, JSON.stringify(failure, null, 2)); record({ type: 'failed', ...failure, samples: undefined }); console.error(JSON.stringify({ event: 'failed', stem, error: failure.error })); process.exitCode = 1;
} finally {
  if (sampling) clearInterval(sampling); if (progress) clearInterval(progress);
  workers.forEach(worker => { if (worker.child.connected) worker.child.send({ type: 'shutdown' }); });
  if (server.child.connected) server.child.send({ type: 'stop' });
  const children = [...workers, server];
  try { await waitUntil(() => children.every(child => child.exited), 10000); }
  catch {
    for (const { child, exited } of children) if (!exited) { record({ type: 'cleanup-signal', pid: child.pid, signal: 'SIGTERM' }); child.kill('SIGTERM'); }
    try { await waitUntil(() => children.every(child => child.exited), 5000); }
    catch { for (const { child, exited } of children) if (!exited) { record({ type: 'cleanup-signal', pid: child.pid, signal: 'SIGKILL' }); child.kill('SIGKILL'); } }
  }
  sleepGuard?.kill('SIGTERM');
}
