import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, platform, release, totalmem } from 'node:os';
import * as Y from 'yjs';
import { createWhiteboardServer } from './server.js';
import { BoardDocument } from '../../model/src/index.js';

const data = process.env.BENCHMARK_DATA_DIR;
if (!data) throw new Error('BENCHMARK_DATA_DIR is required');
mkdirSync(data, { recursive: true });
const app = createWhiteboardServer({ databasePath: join(data, 'whiteboard.sqlite'), assetDirectory: join(data, 'assets'), sessionSecret: randomBytes(48).toString('base64url'), port: Number(process.env.SPIKE_PORT ?? 12347) });
const password = randomBytes(32).toString('base64url'), user = app.store.createUser('load-owner', password);
const board = app.store.createBoard(user.id, 'Production S3 workload'), session = (await app.store.login(user.username, password))!;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function projectionHash(update: Uint8Array) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, update); const model = new BoardDocument(doc, { undo: false });
  try { return { elements: model.readAll().length, hash: createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(model.readAll().map(element => [element.id, element]))))).digest('hex') }; }
  finally { model.destroy(); doc.destroy(); }
}
let previousCpu = process.cpuUsage(), previousTime = performance.now();
function sample() {
  const now = performance.now(), cpu = process.cpuUsage(), elapsedMs = now - previousTime;
  const cpuPctOneCore = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (elapsedMs * 1000) * 100;
  previousCpu = cpu; previousTime = now;
  return { at: Date.now(), elapsedMs, cpuPctOneCore, ...process.memoryUsage(), ...app.network,
    documentStats: [...app.server.hocuspocus.documents].map(([name, doc]) => { const structs = [...doc.store.clients.values()].flat(); return { name, writerArrays: [...doc.share.keys()].filter(key => key.startsWith('element-properties:')).length, retainedStructs: structs.length, deletedStructs: structs.filter(struct => struct.deleted).length }; }),
    persistence: { metrics: app.metrics.get(board.id), storage: app.store.stats(board.id) },
  };
}
process.on('message', async (message: { type: string }) => {
  if (message.type === 'sample') process.send?.({ type: 'sample', ...sample() });
  if (message.type === 'reset') { Object.assign(app.network, { changes: 0, awarenessMessages: 0, inboundMessages: 0, inboundBytes: 0 }); sample(); process.send?.({ type: 'reset' }); }
  if (message.type === 'snapshot') process.send?.({ type: 'snapshot', documents: [...app.server.hocuspocus.documents].map(([name, doc]) => {
    const encoded = Y.encodeStateAsUpdate(doc), projection = projectionHash(encoded), persisted = projectionHash(app.store.loadDocument(name)!);
    return { name, ...projection, encodedBytes: encoded.byteLength, persistedHash: persisted.hash, persistenceMatches: persisted.hash === projection.hash, storage: app.store.stats(name) };
  }) });
  if (message.type === 'stop') { await app.close(); if (process.connected) process.disconnect?.(); }
});
await app.listen();
process.send?.({ type: 'ready', port: app.port, pid: process.pid, boardId: board.id, sessionToken: session.token,
  hardware: { cpu: cpus()[0]?.model, logicalCores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version },
  server: 'Production Hocuspocus/SQLite WAL FULL, signed session ACL checked per packet, update-log compaction at5MiB/10000, raw server document relay',
});
