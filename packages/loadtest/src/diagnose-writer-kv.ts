import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fieldKey = (id: string, field: string) => JSON.stringify([id, field]);
const file = fileURLToPath(new URL('../results/writer-ykeyvalue-exact-workload-diagnosis.json', import.meta.url));
const server = new Y.Doc({ gc: true });
const serverStores: YKeyValue<unknown>[] = [];
const clients = Array.from({ length: 40 }, (_, index) => {
  const doc = new Y.Doc();
  const arrayName = `writer-${doc.clientID}`;
  const kv = new YKeyValue<unknown>(doc.getArray<{ key: string; val: unknown }>(arrayName));
  serverStores.push(new YKeyValue<unknown>(server.getArray<{ key: string; val: unknown }>(arrayName)));
  doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'server') Y.applyUpdate(server, update); });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'server');
  doc.transact(() => {
    for (let slot = 0; slot < 32; slot++) {
      const id = `client-${index}-element-${slot}`;
      Object.entries({ id, type: slot < 24 ? 'stroke' : 'rect', x: index * 40, y: slot * 20, w: 80, h: 40, rotation: 0, index: id,
        style: { stroke: '#172b4d', fill: '#dae8fc', strokeWidth: 2, opacity: 1 },
        props: slot < 24 ? { points: [0, 0, 0.5, 80, 40, 0.5], simplified: true } : {},
      }).forEach(([field, value]) => kv.set(fieldKey(id, field), value));
    }
  });
  return { doc, kv };
});
const started = performance.now();
const cpuStart = process.cpuUsage();
const samples: unknown[] = [];
let completedOperations = 0;
for (let sequence = 0; sequence <= 9000; sequence++) {
  if (sequence > 0) for (const [index, { doc, kv }] of clients.entries()) {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)), 'server');
    const kind = sequence % 5;
    const slot = kind < 3 ? sequence % 24 : 24 + sequence % 8;
    const id = `client-${index}-element-${slot}`;
    doc.transact(() => {
      if (kind < 3) {
        const points: number[] = [];
        for (let point = 0; point < 48; point++) points.push(point * 2 + sequence % 100, Math.sin((point + sequence) / 8) * 30, 0.3 + (point % 7) / 10);
        kv.set(fieldKey(id, 'props'), { points, simplified: true });
      } else if (kind === 3) {
        kv.set(fieldKey(id, 'x'), index * 40 + sequence % 300); kv.set(fieldKey(id, 'y'), sequence % 200);
      } else kv.set(fieldKey(id, 'style'), { stroke: sequence % 2 ? '#4678ca' : '#b84354', fill: '#dae8fc', strokeWidth: 2 + sequence % 3, opacity: 0.8 });
    });
    completedOperations++;
  }
  if (sequence % 250 === 0) {
    const encoded = Y.encodeStateAsUpdate(server);
    const structs = [...server.store.clients.values()].flat();
    const cpu = process.cpuUsage(cpuStart);
    const sample = { operations: completedOperations, elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000,
      liveFields: serverStores.reduce((sum, store) => sum + store.map.size, 0),
      encodedBytes: encoded.byteLength, retainedStructs: structs.length,
      deletedStructs: structs.filter(struct => struct.deleted).length,
      heapUsedBytes: process.memoryUsage().heapUsed,
    };
    samples.push(sample);
    writeFileSync(file, JSON.stringify({ representation: 'one YKeyValue array per actual Yjs writer ID', yjs: '13.6.33', yUtility: '0.1.4', gc: true, clientIds: 40,
      methodology: 'Each client edits only its own array. Before its next edit it receives current server state. Flat per-property keys, 12800 fields. This storage diagnostic does not yet implement cross-writer Lamport merge, lifecycle semantics, or undo. CPU includes clients/state-vector exchange and is not server-only CPU evidence. No awareness/network/undo.', samples }, null, 2));
    console.log(JSON.stringify({ file, ...sample }));
    // Do not spend a long full replay if the storage hypothesis already fails.
    if (completedOperations === 100_000 && structs.length > 40_000) break;
  }
}
clients.forEach(({ doc }) => doc.destroy());
server.destroy();
