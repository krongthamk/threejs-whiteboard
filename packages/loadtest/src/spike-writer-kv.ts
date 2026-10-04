import { Server } from '@hocuspocus/server';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import * as Y from 'yjs';
import { WriterBoardDocument } from '../../../spikes/model-kv/writer-model.js';

const port = Number(process.env.SPIKE_PORT ?? 12346);
const boards = new Map<string, WriterBoardDocument>();
const counters = { changes: 0, awarenessMessages: 0, inboundMessages: 0, inboundBytes: 0 };
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const server = new Server({ port, address: '127.0.0.1', quiet: true,
  async onLoadDocument({ documentName, document }) { boards.set(documentName, new WriterBoardDocument(document, { undo: false })); },
  async afterUnloadDocument({ documentName }) { boards.delete(documentName); },
  async onChange() { counters.changes++; },
  async beforeHandleAwareness() { counters.awarenessMessages++; },
  async beforeHandleMessage({ update }) { counters.inboundMessages++; counters.inboundBytes += update.byteLength; },
});
let previousCpu = process.cpuUsage(), previousTime = performance.now();
function sample() {
  const now = performance.now(), cpu = process.cpuUsage(), elapsedMs = now - previousTime;
  const cpuPctOneCore = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (elapsedMs * 1000) * 100;
  previousCpu = cpu; previousTime = now;
  const documentStats = [...boards.entries()].map(([name, board]) => {
    const structs = [...board.doc.store.clients.values()].flat();
    return { name, writerArrays: board.writers.size, retainedStructs: structs.length, deletedStructs: structs.filter(struct => struct.deleted).length };
  });
  return { at: Date.now(), elapsedMs, cpuPctOneCore, ...process.memoryUsage(), ...counters, documentStats };
}
process.on('message', async (message: { type: string }) => {
  if (message.type === 'sample') process.send?.({ type: 'sample', ...sample() });
  if (message.type === 'reset') { Object.assign(counters, { changes: 0, awarenessMessages: 0, inboundMessages: 0, inboundBytes: 0 }); sample(); process.send?.({ type: 'reset' }); }
  if (message.type === 'snapshot') process.send?.({ type: 'snapshot', documents: [...boards.entries()].map(([name, board]) => ({
    name, elements: board.readAll().length, encodedBytes: Y.encodeStateAsUpdate(board.doc).byteLength,
    hash: createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(board.readAll().map(element => [element.id, element]))))).digest('hex'),
  })) });
  if (message.type === 'stop') { await server.destroy(); if (process.connected) process.disconnect?.(); }
});
await server.listen();
process.send?.({ type: 'ready', port: (server.httpServer.address() as import('node:net').AddressInfo).port, pid: process.pid, hardware: { cpu: cpus()[0]?.model, logicalCores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version } });
