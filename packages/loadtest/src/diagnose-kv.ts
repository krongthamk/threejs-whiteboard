import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const key = (id: string, field: string) => JSON.stringify([id, field]);
const file = fileURLToPath(new URL('../results/ykeyvalue-exact-workload-diagnosis.json', import.meta.url));
const server = new Y.Doc({ gc: true });
const serverKv = new YKeyValue<unknown>(server.getArray<{ key: string; val: unknown }>('element-properties'));
const clients = Array.from({ length: 40 }, (_, index) => {
  const doc = new Y.Doc();
  const kv = new YKeyValue<unknown>(doc.getArray<{ key: string; val: unknown }>('element-properties'));
  doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'server') Y.applyUpdate(server, update); });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'server');
  doc.transact(() => {
    for (let slot = 0; slot < 32; slot++) {
      const id = `client-${index}-element-${slot}`;
      Object.entries({ id, type: slot < 24 ? 'stroke' : 'rect', x: index * 40, y: slot * 20, w: 80, h: 40, rotation: 0, index: id,
        style: { stroke: '#172b4d', fill: '#dae8fc', strokeWidth: 2, opacity: 1 },
        props: slot < 24 ? { points: [0, 0, 0.5, 80, 40, 0.5], simplified: true } : {},
      }).forEach(([field, value]) => kv.set(key(id, field), value));
    }
  });
  return { doc, kv };
});
const started = performance.now();
const cpuStart = process.cpuUsage();
const samples: unknown[] = [];
for (let sequence = 0; sequence <= 9000; sequence++) {
  if (sequence > 0) for (const [index, { doc, kv }] of clients.entries()) {
    // Give this writer the current server state before its next edit, ensuring
    // globally interleaved array appends rather than 40 isolated offline runs.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)), 'server');
    const kind = sequence % 5;
    const slot = kind < 3 ? sequence % 24 : 24 + sequence % 8;
    const id = `client-${index}-element-${slot}`;
    doc.transact(() => {
      if (kind < 3) {
        const points: number[] = [];
        for (let point = 0; point < 48; point++) points.push(point * 2 + sequence % 100, Math.sin((point + sequence) / 8) * 30, 0.3 + (point % 7) / 10);
        kv.set(key(id, 'props'), { points, simplified: true });
      } else if (kind === 3) {
        kv.set(key(id, 'x'), index * 40 + sequence % 300); kv.set(key(id, 'y'), sequence % 200);
      } else kv.set(key(id, 'style'), { stroke: sequence % 2 ? '#4678ca' : '#b84354', fill: '#dae8fc', strokeWidth: 2 + sequence % 3, opacity: 0.8 });
    });
  }
  if (sequence % 125 === 0) {
    const encoded = Y.encodeStateAsUpdate(server);
    const structs = [...server.store.clients.values()].flat();
    const cpu = process.cpuUsage(cpuStart);
    const sample = { operations: sequence * 40, elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000,
      liveFields: serverKv.map.size, arrayLength: server.getArray('element-properties').length,
      encodedBytes: encoded.byteLength, retainedStructs: structs.length,
      deletedStructs: structs.filter(struct => struct.deleted).length,
      heapUsedBytes: process.memoryUsage().heapUsed,
    };
    samples.push(sample);
    writeFileSync(file, JSON.stringify({ representation: 'flat YKeyValue', yjs: '13.6.33', yUtility: '0.1.4', gc: true, clientIds: 40,
      methodology: 'Before each mutation, the next writer receives the current server state. This tests interleaved multi-writer metadata retention with 14080 per-property keys, not whole-element LWW. CPU includes in-process clients and state-vector exchange, so it is not server-only CPU evidence. No awareness/network/undo.', samples }, null, 2));
    if (sequence % 1500 === 0) console.log(JSON.stringify({ file, ...sample }));
  }
}
clients.forEach(({ doc }) => doc.destroy());
server.destroy();
