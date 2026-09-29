import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WriterBoardDocument } from '../../../spikes/model-kv/writer-model.js';
import { createElement } from '../../model/src/index.js';

const workerIndex = Number(process.env.WORKER_INDEX), clientsPerWorker = 5;
const totalClients = 40, durationSeconds = Number(process.env.DURATION_SECONDS ?? 1800);
const latencyFile = `${process.env.RESULT_STEM}.worker-${workerIndex}.latencies.f64le`;
writeFileSync(latencyFile, Buffer.alloc(0));
const traffic = { sentBytes: 0, receivedBytes: 0, sentMessages: 0, receivedMessages: 0, awarenessSent: 0, awarenessReceived: 0 };
function size(data: any): number { return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength ?? data.length ?? 0; }
function awareness(data: any): boolean {
  const bytes = typeof data === 'string' ? Buffer.from(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, size(data));
  let length = 0, shift = 0, pos = 0, byte: number;
  do { byte = bytes[pos++]!; length += (byte & 127) * 2 ** shift; shift += 7; } while (byte >= 128 && pos < bytes.length);
  return bytes[pos + length] === 1;
}
class MeasuredSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols);
    this.on('error', () => { /* Provider records failure; keep shutdown on a connecting socket from becoming unhandled. */ });
    this.on('message', data => { traffic.receivedBytes += size(data); traffic.receivedMessages++; if (awareness(data)) traffic.awarenessReceived++; });
  }
  override send(data: any, ...args: any[]) { traffic.sentBytes += size(data); traffic.sentMessages++; if (awareness(data)) traffic.awarenessSent++; return super.send(data, ...args); }
}
type Operation = { started: number; remaining: number };
type Client = { index: number; board: WriterBoardDocument; provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; sequence: number; cursors: number; active: Operation | null; acks: (Operation | null)[] };
const clients: Client[] = [], latencies: number[] = [];
let running = false, stopping = false, disconnects = 0, documentUpdates = 0, documentAcknowledgements = 0, savedLatencies = 0;
let startedAt = 0, endedAt = 0, maxSchedulerLagMs = 0;
const timers: ReturnType<typeof setInterval>[] = [];
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const waitUntil = (check: () => boolean, timeout = 60000) => new Promise<void>((resolveWait, reject) => {
  const start = performance.now();
  const timer = setInterval(() => { if (check()) { clearInterval(timer); resolveWait(); } else if (performance.now() - start > timeout) { clearInterval(timer); reject(new Error('Worker synchronization timeout')); } }, 50);
});
function persistLatencies() {
  const bytes = Buffer.allocUnsafe((latencies.length - savedLatencies) * 8);
  for (let i = savedLatencies; i < latencies.length; i++) bytes.writeDoubleLE(latencies[i]!, (i - savedLatencies) * 8);
  appendFileSync(latencyFile, bytes); savedLatencies = latencies.length;
}
function metrics() { return { workerIndex, pid: process.pid, startedAt, endedAt, operations: clients.reduce((sum, client) => sum + client.sequence, 0), acknowledged: latencies.length,
  cursorUpdates: clients.reduce((sum, client) => sum + client.cursors, 0), documentUpdates, documentAcknowledgements, disconnects, maxSchedulerLagMs, traffic: { ...traffic },
  pendingPackets: clients.reduce((sum, client) => sum + client.acks.length, 0), memory: process.memoryUsage(), latencyFile,
}; }
async function stop(failed?: unknown) {
  if (stopping) return; stopping = true; timers.forEach(clearInterval);
  if (!failed) {
    try { await waitUntil(() => clients.every(client => client.acks.length === 0 && !client.provider.hasUnsyncedChanges), 30000); }
    catch (error) { failed = error; }
  }
  persistLatencies();
  const hashes = failed ? [] : clients.map(client => createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(client.board.readAll().map(element => [element.id, element]))))).digest('hex'));
  process.send?.({ type: failed ? 'failed' : 'done', ...metrics(), hashes, error: failed instanceof Error ? failed.message : failed ? String(failed) : undefined });
  // Keep synchronized providers alive until the coordinator checks server and
  // all worker hashes; it sends shutdown after that check.
}
function shutdown() { running = false; timers.forEach(clearInterval); for (const client of clients) { client.provider.destroy(); client.socket.destroy(); client.board.destroy(); } if (process.connected) process.disconnect?.(); }
process.on('message', async (message: { type: string; startedAt?: number }) => {
  try {
    if (message.type === 'initialize') {
      for (const client of clients) client.board.transact(() => {
        for (let slot = 0; slot < 32; slot++) {
          const id = `client-${client.index}-element-${slot}`;
          const input = { id, x: client.index * 40, y: slot * 20, w: 80, h: 40, style: { stroke: '#172b4d', fill: '#dae8fc', strokeWidth: 2, opacity: 1 } };
          client.board.add(slot < 24 ? createElement('stroke', { ...input, props: { points: [0, 0, 0.5, 80, 40, 0.5], simplified: true } }) : createElement('rect', input));
        }
      });
      await waitUntil(() => clients.every(client => !client.provider.hasUnsyncedChanges && client.board.readAll().length === totalClients * 32));
      process.send?.({ type: 'initialized', workerIndex });
    }
    if (message.type === 'start') {
      startedAt = message.startedAt!;
      const delay = Math.max(0, startedAt - Date.now());
      timers.push(setTimeout(() => {
        Object.keys(traffic).forEach(key => { traffic[key as keyof typeof traffic] = 0; });
        running = true;
        const clockStart = performance.now() - (Date.now() - startedAt);
        let previousPump = performance.now();
        const pump = () => {
          const now = performance.now(), gap = now - previousPump; maxSchedulerLagMs = Math.max(maxSchedulerLagMs, gap); previousPump = now;
          if (gap > 1000) throw new Error(`Workload scheduler stalled for ${gap.toFixed(1)}ms; required cadence was not maintained`);
          const elapsed = Math.min(durationSeconds, Math.max(0, (now - clockStart) / 1000));
          const targetOps = Math.min(durationSeconds * 5, Math.floor(elapsed * 5) + 1), targetCursors = Math.min(durationSeconds * 20, Math.floor(elapsed * 20) + 1);
          for (const client of clients) {
            while (client.sequence < targetOps) {
              const sequence = ++client.sequence, kind = sequence % 5, slot = kind < 3 ? sequence % 24 : 24 + sequence % 8;
              const id = `client-${client.index}-element-${slot}`, operation: Operation = { started: performance.now(), remaining: 0 };
              client.active = operation;
              try {
                if (kind < 3) {
                  const points: number[] = [];
                  for (let point = 0; point < 48; point++) points.push(point * 2 + sequence % 100, Math.sin((point + sequence) / 8) * 30, 0.3 + (point % 7) / 10);
                  client.board.update(id, { props: { points, simplified: true } });
                } else if (kind === 3) client.board.update(id, { x: client.index * 40 + sequence % 300, y: sequence % 200 });
                else client.board.updateStyle([id], { stroke: sequence % 2 ? '#4678ca' : '#b84354', fill: '#dae8fc', strokeWidth: 2 + sequence % 3, opacity: 0.8 });
              } finally { client.active = null; }
              if (operation.remaining === 0) throw new Error('A scheduled gesture generated no document update');
            }
            while (client.cursors < targetCursors) {
              const tick = ++client.cursors;
              client.provider.setAwarenessField('cursor', { x: Math.sin(tick / 100) * 500 + client.index * 10, y: Math.cos(tick / 100) * 300 });
            }
          }
        };
        const safePump = () => { try { pump(); } catch (error) { void stop(error); } };
        safePump(); timers.push(setInterval(safePump, 10));
        timers.push(setInterval(() => { persistLatencies(); process.send?.({ type: 'worker-sample', ...metrics() }); }, 5000));
        timers.push(setTimeout(() => { safePump(); endedAt = Date.now(); void stop(); }, Math.max(0, startedAt + durationSeconds * 1000 - Date.now())));
      }, delay));
    }
    if (message.type === 'shutdown') shutdown();
  } catch (error) { void stop(error); }
});
try {
  for (let local = 0; local < clientsPerWorker; local++) {
    const index = workerIndex * clientsPerWorker + local, doc = new Y.Doc(), board = new WriterBoardDocument(doc, { undo: false });
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${process.env.SPIKE_PORT ?? 12346}`, WebSocketPolyfill: MeasuredSocket });
    let previous = 0;
    const client: Client = { index, board, socket, provider: undefined as unknown as HocuspocusProvider, sequence: 0, cursors: 0, active: null, acks: [] };
    client.provider = new HocuspocusProvider({ websocketProvider: socket, name: 's3-writer-board', document: doc,
      onUnsyncedChanges({ number }) {
        if (running) {
          if (number > previous) for (let i = previous; i < number; i++) { const op = client.active; if (op) op.remaining++; client.acks.push(op); documentUpdates++; }
          if (number < previous) for (let i = number; i < previous; i++) { const op = client.acks.shift(); documentAcknowledgements++; if (op && --op.remaining === 0) latencies.push(performance.now() - op.started); }
        }
        previous = number;
      },
      onDisconnect() { if (running) disconnects++; },
    });
    client.provider.attach();
    client.provider.awareness?.setLocalState({ userId: `load-${index}`, name: `User ${index}`, color: '#4678ca', cursor: { x: 0, y: 0 }, selection: [], editingTextId: null });
    clients.push(client);
  }
  await waitUntil(() => clients.every(client => client.provider.isSynced && !client.provider.hasUnsyncedChanges));
  process.send?.({ type: 'connected', workerIndex });
} catch (error) { void stop(error); }
