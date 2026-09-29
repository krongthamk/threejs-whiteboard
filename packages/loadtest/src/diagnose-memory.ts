import * as Y from 'yjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function structure(doc: Y.Doc) {
  const kinds: Record<string, number> = {};
  for (const structs of doc.store.clients.values()) for (const struct of structs) {
    const kind = `${struct.constructor.name}:${struct.deleted ? 'deleted' : 'live'}`;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

// Diagnostic only: does not replace the timed 40-client S3 run.
// Compare CRDT metadata retention with awareness and transport absent.
const operations = 100_000;
const output = [];
for (const slots of [1, 32]) {
  const doc = new Y.Doc({ gc: true });
  const elements = doc.getMap<Y.Map<unknown>>('elements');
  for (let slot = 0; slot < slots; slot++) {
    const element = new Y.Map<unknown>();
    elements.set(String(slot), element);
    element.set('props', { points: [0, 0, 0.5, 1, 1, 0.5], simplified: true });
  }
  const samples = [];
  for (let operation = 0; operation <= operations; operation++) {
    if (operation % 10_000 === 0) {
      const encoded = Y.encodeStateAsUpdate(doc);
      const reloaded = new Y.Doc();
      Y.applyUpdate(reloaded, encoded);
      samples.push({ operation, liveElements: elements.size, encodedBytes: encoded.byteLength,
        kinds: structure(doc),
        retainedStructs: [...doc.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0),
        retainedStructsAfterSnapshotReload: [...reloaded.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0),
      });
      reloaded.destroy();
    }
    if (operation === operations) break;
    elements.get(String(operation % slots))!.set('props', { points: [operation, 0, 0.5, operation + 1, 1, 0.5], simplified: true });
  }
  output.push({ slots, samples });
  doc.destroy();
}
const file = fileURLToPath(new URL('../results/yjs-metadata-diagnosis.json', import.meta.url));
writeFileSync(file, JSON.stringify({ yjs: '13.6.33', gc: true, operations, awareness: false, network: false, output }, null, 2));
console.log(JSON.stringify({ file, output }, null, 2));

// Replay the exact S3 mix from 40 client IDs into an authoritative server Doc.
// No awareness objects, network, UndoManager, or timers participate.
const server = new Y.Doc({ gc: true });
const clients = Array.from({ length: 40 }, (_, index) => {
  const doc = new Y.Doc();
  doc.on('update', (update: Uint8Array) => Y.applyUpdate(server, update));
  doc.transact(() => {
    for (let slot = 0; slot < 32; slot++) {
      const id = `client-${index}-element-${slot}`;
      const element = new Y.Map<unknown>();
      Object.entries({ id, type: slot < 24 ? 'stroke' : 'rect', x: index * 40, y: slot * 20, w: 80, h: 40, rotation: 0, index: id,
        style: { stroke: '#172b4d', fill: '#dae8fc', strokeWidth: 2, opacity: 1 },
        props: slot < 24 ? { points: [0, 0, 0.5, 80, 40, 0.5], simplified: true } : {},
      }).forEach(([key, value]) => element.set(key, value));
      doc.getMap('elements').set(id, element);
    }
  });
  return doc;
});
const exactSamples = [];
for (let sequence = 0; sequence <= 9000; sequence++) {
  if (sequence > 0) for (const [index, doc] of clients.entries()) {
    const kind = sequence % 5;
    const slot = kind < 3 ? sequence % 24 : 24 + sequence % 8;
    const element = doc.getMap<Y.Map<unknown>>('elements').get(`client-${index}-element-${slot}`)!;
    doc.transact(() => {
      if (kind < 3) {
        const points: number[] = [];
        for (let point = 0; point < 48; point++) points.push(point * 2 + sequence % 100, Math.sin((point + sequence) / 8) * 30, 0.3 + (point % 7) / 10);
        element.set('props', { points, simplified: true });
      } else if (kind === 3) {
        element.set('x', index * 40 + sequence % 300); element.set('y', sequence % 200);
      } else element.set('style', { stroke: sequence % 2 ? '#4678ca' : '#b84354', fill: '#dae8fc', strokeWidth: 2 + sequence % 3, opacity: 0.8 });
    });
  }
  if (sequence % 1500 === 0) {
    const encoded = Y.encodeStateAsUpdate(server);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, encoded);
    exactSamples.push({ simulatedMinutes: sequence / 300, operations: sequence * 40,
      liveElements: server.getMap('elements').size, encodedBytes: encoded.byteLength,
      retainedStructs: [...server.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0),
      kinds: structure(server),
      retainedStructsAfterSnapshotReload: [...reloaded.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0),
    });
    reloaded.destroy();
  }
}
const exactFile = fileURLToPath(new URL('../results/yjs-exact-workload-diagnosis.json', import.meta.url));
writeFileSync(exactFile, JSON.stringify({ yjs: '13.6.33', gc: true, clients: 40, awareness: false, network: false, exactSamples }, null, 2));
console.log(JSON.stringify({ file: exactFile, exactSamples }, null, 2));
clients.forEach(doc => doc.destroy());
server.destroy();
