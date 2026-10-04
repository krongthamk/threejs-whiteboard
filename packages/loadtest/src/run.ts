import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { fork } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const durationSeconds = Number(process.env.DURATION_SECONDS ?? 1800);
const clientCount = Number(process.env.CLIENTS ?? 40);
const opsPerSecond = Number(process.env.OPS_PER_SECOND ?? 5);
const cursorHz = Number(process.env.CURSOR_HZ ?? 20);
const output = process.env.RESULT_FILE ? resolve(process.env.RESULT_FILE) : fileURLToPath(new URL(`../results/s3-${new Date().toISOString().replaceAll(':', '-')}.json`, import.meta.url));
mkdirSync(dirname(output), { recursive: true });
const rawFile = output.replace(/\.json$/, '.ndjson');
const record = (data: object) => appendFileSync(rawFile, `${JSON.stringify(data)}\n`);
const server = fork(fileURLToPath(new URL('./spike.ts', import.meta.url)), [], {
  execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: { ...process.env, SPIKE_PORT: process.env.SPIKE_PORT ?? '12345' },
});
type Sample = { at: number; elapsedMs: number; cpuPctOneCore: number; rss: number; heapUsed: number; changes: number; awarenessMessages: number; inboundMessages: number; inboundBytes: number };
const samples: Sample[] = [];
server.on('message', (message: { type: string } & Sample) => {
  if (message.type === 'sample') { samples.push(message); record(message); }
});
function response(type: string, timeout = 15000): Promise<Record<string, any>> {
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => { server.off('message', listener); reject(new Error(`Timed out waiting for server ${type}`)); }, timeout);
    const listener = (message: Record<string, any>) => {
      if (message.type !== type) return;
      clearTimeout(timer); server.off('message', listener); resolveResponse(message);
    };
    server.on('message', listener);
  });
}
const ready = await response('ready');
record(ready);
const traffic = { sentBytes: 0, receivedBytes: 0, sentMessages: 0, receivedMessages: 0, awarenessSent: 0, awarenessReceived: 0 };
function size(data: any): number { return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength ?? data.length ?? 0; }
function isAwareness(data: any): boolean {
  const bytes = typeof data === 'string' ? Buffer.from(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, size(data));
  let length = 0, shift = 0, position = 0, value: number;
  do { value = bytes[position++]!; length += (value & 127) * 2 ** shift; shift += 7; } while (value >= 128 && position < bytes.length);
  return bytes[position + length] === 1;
}
class MeasuredWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols);
    this.on('message', (data) => {
      traffic.receivedBytes += size(data); traffic.receivedMessages++;
      if (isAwareness(data)) traffic.awarenessReceived++;
    });
  }
  override send(data: any, ...args: any[]) {
    traffic.sentBytes += size(data); traffic.sentMessages++;
    if (isAwareness(data)) traffic.awarenessSent++;
    return super.send(data, ...args);
  }
}
const latencies: number[] = [];
let running = false;
let operationCount = 0;
let cursorCount = 0;
let disconnects = 0;
type Client = { doc: Y.Doc; provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; pending: number[]; sequence: number; cursors: number };
const clients: Client[] = [];
function waitUntil(check: () => boolean, timeout = 30000): Promise<void> {
  const start = performance.now();
  return new Promise((resolveWait, reject) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolveWait(); }
      else if (performance.now() - start > timeout) { clearInterval(timer); reject(new Error('Client synchronization timeout')); }
    }, 20);
  });
}
try {
  for (let index = 0; index < clientCount; index++) {
    const doc = new Y.Doc();
    const pending: number[] = [];
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${ready.port}`, WebSocketPolyfill: MeasuredWebSocket });
    let previousUnsynced = 0;
    const provider = new HocuspocusProvider({
      websocketProvider: socket, name: 's3-load-board', document: doc,
      onUnsyncedChanges({ number }) {
        if (running && number < previousUnsynced) {
          for (let ack = number; ack < previousUnsynced; ack++) {
            const sentAt = pending.shift();
            if (sentAt !== undefined) latencies.push(performance.now() - sentAt);
          }
        }
        previousUnsynced = number;
      },
      onDisconnect() { if (running) disconnects++; },
    });
    provider.attach();
    provider.awareness?.setLocalState({ userId: `load-${index}`, name: `User ${index}`, color: '#4678ca', cursor: { x: 0, y: 0 }, selection: [], editingTextId: null });
    clients.push({ doc, provider, socket, pending, sequence: 0, cursors: 0 });
  }
  await waitUntil(() => clients.every(client => client.provider.isSynced && !client.provider.hasUnsyncedChanges));
  for (const [index, client] of clients.entries()) {
    client.doc.transact(() => {
      for (let slot = 0; slot < 32; slot++) {
        const id = `client-${index}-element-${slot}`;
        const element = new Y.Map();
        Object.entries({ id, type: slot < 24 ? 'stroke' : 'rect', x: index * 40, y: slot * 20, w: 80, h: 40, rotation: 0, index: id,
          style: { stroke: '#172b4d', fill: '#dae8fc', strokeWidth: 2, opacity: 1 },
          props: slot < 24 ? { points: [0, 0, 0.5, 80, 40, 0.5], simplified: true } : {},
        }).forEach(([key, value]) => element.set(key, value));
        client.doc.getMap('elements').set(id, element);
      }
    });
  }
  await waitUntil(() => clients.every(client => !client.provider.hasUnsyncedChanges && client.doc.getMap('elements').size === clientCount * 32));
  const resetResponse = response('reset'); server.send({ type: 'reset' }); await resetResponse;
  Object.keys(traffic).forEach(key => { traffic[key as keyof typeof traffic] = 0; });
  const startedAt = Date.now();
  record({ type: 'start', startedAt, durationSeconds, clientCount, opsPerSecond, cursorHz, workload: '1280 bounded elements; 60% pressure stroke replacement, 20% move, 20% recolor; 32 slots per user' });
  console.log(JSON.stringify({ event: 'started', output, rawFile, serverPid: ready.pid, durationSeconds, clientCount, opsPerSecond, cursorHz }));
  running = true;
  // Use deadlines rather than independent setIntervals: timer drift must not
  // silently reduce the requested rate during a long run.
  const clockStart = performance.now();
  let maxSchedulerLagMs = 0;
  let previousPump = clockStart;
  const pump = () => {
    const now = performance.now();
    maxSchedulerLagMs = Math.max(maxSchedulerLagMs, now - previousPump);
    previousPump = now;
    const elapsed = Math.min(durationSeconds, (now - clockStart) / 1000);
    const targetOps = Math.min(durationSeconds * opsPerSecond, Math.floor(elapsed * opsPerSecond) + 1);
    const targetCursors = Math.min(durationSeconds * cursorHz, Math.floor(elapsed * cursorHz) + 1);
    for (const [index, client] of clients.entries()) {
      while (client.sequence < targetOps) {
      const sequence = ++client.sequence;
      const kind = sequence % 5;
      const slot = kind < 3 ? sequence % 24 : 24 + sequence % 8;
      const element = client.doc.getMap<Y.Map<unknown>>('elements').get(`client-${index}-element-${slot}`)!;
      client.pending.push(performance.now());
      client.doc.transact(() => {
        if (kind < 3) {
          const points: number[] = [];
          for (let point = 0; point < 48; point++) points.push(point * 2 + sequence % 100, Math.sin((point + sequence) / 8) * 30, 0.3 + (point % 7) / 10);
          element.set('props', { points, simplified: true });
        } else if (kind === 3) {
          element.set('x', index * 40 + sequence % 300); element.set('y', sequence % 200);
        } else element.set('style', { stroke: sequence % 2 ? '#4678ca' : '#b84354', fill: '#dae8fc', strokeWidth: 2 + sequence % 3, opacity: 0.8 });
      }, 'load-client');
      operationCount++;
      }
      while (client.cursors < targetCursors) {
      const tick = ++client.cursors;
      client.provider.setAwarenessField('cursor', { x: Math.sin(tick / 100) * 500 + index * 10, y: Math.cos(tick / 100) * 300 });
      cursorCount++;
      }
    }
  };
  pump();
  const scheduler = setInterval(pump, 10);
  const sampling = setInterval(() => server.send({ type: 'sample' }), 5000);
  const progress = setInterval(() => console.log(JSON.stringify({ event: 'progress', elapsedSeconds: (Date.now() - startedAt) / 1000, operationCount, acknowledged: latencies.length, cursorCount, latestSample: samples.at(-1) })), 60000);
  await new Promise(resolveDelay => setTimeout(resolveDelay, durationSeconds * 1000));
  pump();
  clearInterval(scheduler); clearInterval(sampling); clearInterval(progress);
  const endedAt = Date.now();
  await waitUntil(() => clients.every(client => client.pending.length === 0 && !client.provider.hasUnsyncedChanges));
  const sampleResponse = response('sample'); server.send({ type: 'sample' }); await sampleResponse;
  const snapshotResponse = response('snapshot'); server.send({ type: 'snapshot' }); const snapshot = await snapshotResponse;
  // Object insertion order differs across replicas; compare deterministic semantic JSON.
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const states = clients.map(client => JSON.stringify(canonical(client.doc.getMap('elements').toJSON())));
  const hashes = states.map(state => createHash('sha256').update(state).digest('hex'));
  const converged = states.every(state => state === states[0]) && snapshot.documents.length === 1 && snapshot.documents[0].hash === hashes[0];
  latencies.sort((a, b) => a - b);
  const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  const measuredSeconds = (endedAt - startedAt) / 1000;
  const warmSamples = samples.filter(sample => sample.at >= startedAt + 5 * 60 * 1000);
  const slopeSamples = warmSamples.length >= 2 ? warmSamples : samples;
  const meanTime = slopeSamples.reduce((sum, sample) => sum + (sample.at - startedAt) / 60000, 0) / slopeSamples.length;
  const meanRss = slopeSamples.reduce((sum, sample) => sum + sample.rss / 1048576, 0) / slopeSamples.length;
  const rssSlopeMiBPerMinute = slopeSamples.reduce((sum, sample) => sum + ((sample.at - startedAt) / 60000 - meanTime) * (sample.rss / 1048576 - meanRss), 0) / slopeSamples.reduce((sum, sample) => sum + ((sample.at - startedAt) / 60000 - meanTime) ** 2, 0);
  const summary = {
    startedAt, endedAt, measuredSeconds, hardware: ready.hardware, serverPid: ready.pid,
    config: { durationSeconds, clientCount, opsPerSecond, cursorHz, boundedElements: clientCount * 32 },
    operations: operationCount, acknowledged: latencies.length, cursorUpdates: cursorCount, disconnects, maxSchedulerLagMs,
    actualOpsPerClientPerSecond: operationCount / clientCount / measuredSeconds,
    actualCursorsPerClientPerSecond: cursorCount / clientCount / measuredSeconds,
    roundTripMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), p99: quantile(latencies, 0.99), max: latencies.at(-1) },
    cpuPctOneCore: { mean: samples.reduce((sum, sample) => sum + sample.cpuPctOneCore, 0) / samples.length, p95: quantile(samples.map(sample => sample.cpuPctOneCore), 0.95), max: Math.max(...samples.map(sample => sample.cpuPctOneCore)) },
    memory: { firstRss: samples[0]?.rss, lastRss: samples.at(-1)?.rss, peakRss: Math.max(...samples.map(sample => sample.rss)), rssSlopeMiBPerMinuteAfterWarmup: rssSlopeMiBPerMinute, warmupSeconds: warmSamples.length >= 2 ? 300 : 0 },
    traffic: { ...traffic, sentBytesPerSecond: traffic.sentBytes / measuredSeconds, receivedBytesPerSecond: traffic.receivedBytes / measuredSeconds, awarenessMessagesPerSecond: traffic.awarenessSent / measuredSeconds },
    converged, snapshot, clientHashes: hashes, samples,
    gate: { duration: measuredSeconds >= 1800, workload: clientCount === 40 && opsPerSecond === 5 && cursorHz === 20 && operationCount === clientCount * durationSeconds * opsPerSecond && cursorCount === clientCount * durationSeconds * cursorHz,
      latency: quantile(latencies, 0.95) < 150, cpu: Math.max(...samples.map(sample => sample.cpuPctOneCore)) < 70,
      // "Flat" was unspecified numerically: record the threshold before any run.
      memory: measuredSeconds >= 1800 && Math.abs(rssSlopeMiBPerMinute) < 1,
      acknowledgements: operationCount === latencies.length && disconnects === 0, converged },
    methodology: { roundTrip: 'Document transaction start to built-in Hocuspocus SyncStatus acknowledgement; no stateless ping substitute.', cpu: 'Child server process cpuUsage delta / wall time; 100% means one logical core.', memory: 'Five-second RSS samples; post-five-minute linear slope <1 MiB/min absolute, bounded 1280-element workload. Not evidence of flat memory for an ever-growing document.', traffic: 'WebSocket application payload bytes excluding TCP/TLS/frame headers; aggregate over all clients.', target: 'This Mac was selected by the user as the initial deployment and benchmark target.' },
  };
  const latencyBytes = Buffer.allocUnsafe(latencies.length * 8);
  latencies.forEach((value, index) => latencyBytes.writeDoubleLE(value, index * 8));
  writeFileSync(output.replace(/\.json$/, '.latencies.f64le'), latencyBytes);
  writeFileSync(output, JSON.stringify(summary, null, 2));
  record({ type: 'complete', ...summary, samples: undefined });
  console.log(JSON.stringify({ event: 'complete', output, ...summary, samples: undefined, clientHashes: undefined, snapshot: undefined }));
} catch (error) {
  // Failed runs are evidence too. Keep all observations before cleanup, even
  // when the acknowledgement drain or convergence check cannot complete.
  latencies.sort((a, b) => a - b);
  const latencyBytes = Buffer.allocUnsafe(latencies.length * 8);
  latencies.forEach((value, index) => latencyBytes.writeDoubleLE(value, index * 8));
  writeFileSync(output.replace(/\.json$/, '.latencies.f64le'), latencyBytes);
  const failure = { status: 'failed', error: error instanceof Error ? error.message : String(error), failedAt: Date.now(),
    hardware: ready.hardware, serverPid: ready.pid, config: { durationSeconds, clientCount, opsPerSecond, cursorHz },
    operations: operationCount, acknowledged: latencies.length, cursorUpdates: cursorCount, disconnects,
    traffic, samples, clients: clients.map(client => ({ pending: client.pending.length, unsynced: client.provider.unsyncedChanges, synced: client.provider.isSynced })),
    gate: { passed: false }, note: 'Partial observations from a failed run; no convergence or completed-run percentile claim.' };
  writeFileSync(output.replace(/\.json$/, '.failure.json'), JSON.stringify(failure, null, 2));
  record({ type: 'failed', ...failure, samples: undefined });
  console.error(JSON.stringify({ event: 'failed', output, ...failure, samples: undefined, clients: undefined }));
  process.exitCode = 1;
} finally {
  running = false;
  for (const client of clients) { client.provider.destroy(); client.socket.destroy(); client.doc.destroy(); }
  if (server.connected) server.send({ type: 'stop' });
}
