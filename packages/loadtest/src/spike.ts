import { Server } from '@hocuspocus/server';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';

// A separate process keeps server CPU and memory distinct from the 40 clients.
const port = Number(process.env.SPIKE_PORT ?? 12345);
const counters = { changes: 0, awarenessMessages: 0, inboundMessages: 0, inboundBytes: 0 };
const server = new Server({
  port,
  address: '127.0.0.1',
  quiet: true,
  async onChange() { counters.changes++; },
  async beforeHandleAwareness() { counters.awarenessMessages++; },
  async beforeHandleMessage({ update }) {
    counters.inboundMessages++;
    counters.inboundBytes += update.byteLength;
  },
});

let previousCpu = process.cpuUsage();
let previousTime = performance.now();
function sample() {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const elapsedMs = now - previousTime;
  const cpuPctOneCore = ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (elapsedMs * 1000)) * 100;
  previousCpu = cpu;
  previousTime = now;
  return { at: Date.now(), elapsedMs, cpuPctOneCore, ...process.memoryUsage(), ...counters };
}

process.on('message', async (message: { type: string }) => {
  if (message.type === 'sample') process.send?.({ type: 'sample', ...sample() });
  if (message.type === 'reset') {
    Object.assign(counters, { changes: 0, awarenessMessages: 0, inboundMessages: 0, inboundBytes: 0 });
    sample();
    process.send?.({ type: 'reset' });
  }
  if (message.type === 'snapshot') {
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const documents = [...server.hocuspocus.documents.values()].map(document => ({
      name: document.name,
      elements: document.getMap('elements').size,
      hash: createHash('sha256').update(JSON.stringify(canonical(document.getMap('elements').toJSON()))).digest('hex'),
    }));
    process.send?.({ type: 'snapshot', documents });
  }
  if (message.type === 'stop') {
    await server.destroy();
    if (process.connected) process.disconnect?.();
  }
});

await server.listen();
process.send?.({
  type: 'ready', port: (server.httpServer.address() as import('node:net').AddressInfo).port, pid: process.pid,
  hardware: { cpu: cpus()[0]?.model, logicalCores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version },
});
