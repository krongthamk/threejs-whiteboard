import * as Y from 'yjs';
import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertValidElement, bindToElement, getElementBounds, type Element, type ElementType } from '../../packages/model/src/index.js';
import { CLOCK_KEY, WriterBoardDocument } from './writer-model.js';

const NETWORK = Symbol('network'), SEED = 0x51a7e;
function rng(seed: number): () => number { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n; return ((n ^ n >>> 14) >>> 0) / 4294967296; }; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

it('writer-owned candidate: 10,000 concurrent pairs across three clients preserve semantic validity, history and raw convergence', () => {
  const started = performance.now(), random = rng(SEED), integer = (n: number) => Math.floor(random() * n);
  const choose = <T>(values: readonly T[]): T => values[integer(values.length)]!;
  const types: readonly ElementType[] = ['rect', 'ellipse', 'sticky', 'text', 'stroke', 'connector', 'image'];
  const seed = new WriterBoardDocument();
  for (let i = 0; i < 28; i++) seed.create(types[i % types.length]!, { id: `seed-${i}`, x: i * 20, y: i * 10 });
  const clients = [1, 2, 3].map(clientID => {
    const doc = new Y.Doc(); doc.clientID = clientID; Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed.doc), NETWORK); return new WriterBoardDocument(doc);
  });
  seed.destroy();
  const outbound: { source: number; update: Uint8Array }[] = [];
  clients.forEach((client, source) => client.doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== NETWORK) outbound.push({ source, update }); }));
  const counts: Record<string, number> = {}, clocks = [0, 0, 0]; let validatedElements = 0, deliveredUpdates = 0;
  const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const coordinate = () => integer(2000) - 1000;
  function operation(client: WriterBoardDocument, sequence: number): void {
    const all = client.readAll(), element = choose(all), action = integer(15);
    if (action === 13 && client.undoManager.undoStack.length) { client.undoManager.undo(); count('undo'); return; }
    if (action === 14 && client.undoManager.redoStack.length) { client.undoManager.redo(); count('redo'); return; }
    if (all.length < 10 || action === 0 && all.length < 48) { client.create(choose(types), { id: `new-${sequence}`, x: coordinate(), y: coordinate() }); count('create'); return; }
    if (action === 1 && all.length > 10) { client.delete(element.id); count('delete'); return; }
    if (action === 2) { client.move([element.id], { x: integer(41) - 20, y: integer(41) - 20 }); count('move'); return; }
    if (action === 3) { client.updateStyle([element.id], { fill: `#${integer(0x1000000).toString(16).padStart(6, '0')}`, opacity: random(), fontSize: 8 + integer(50), strokeWidth: integer(16) }); count('style'); return; }
    if (action === 4) { client.update(element.id, { w: 1 + integer(500), h: 1 + integer(500) }); count('resize'); return; }
    if (action === 5) { client.update(element.id, { rotation: random() * Math.PI * 2 }); count('rotate'); return; }
    if (action === 6) { client.update(element.id, { index: `a${String.fromCharCode(65 + integer(26))}` }); count('order'); return; }
    if (action === 7) {
      const target = choose(all.filter(e => e.type === 'text' || e.type === 'sticky'));
      if (target) { client.update(target.id, { props: { text: `Sequence ${sequence}\nΩ中 🖊️`, align: choose(['left', 'center', 'right'] as const), autoSize: random() > .5 } }); count('text'); return; }
    }
    if (action === 8) {
      const target = choose(all.filter(e => e.type === 'stroke'));
      if (target) { client.update(target.id, { props: { points: Array.from({ length: 1 + integer(15) }, () => [coordinate(), coordinate(), random()]).flat(), simplified: random() > .5 } }); count('stroke'); return; }
    }
    if (action === 9) {
      const target = choose(all.filter(e => e.type === 'connector')), anchor = choose(all.filter(e => e.type !== 'connector'));
      if (target && anchor) { client.update(target.id, { props: { start: bindToElement(anchor, random(), random()), end: { x: coordinate(), y: coordinate() }, kind: choose(['straight', 'elbow', 'curve'] as const) } }); count('binding'); return; }
    }
    if (action === 10) {
      const target = choose(all.filter(e => e.type === 'image'));
      if (target) { client.update(target.id, { props: { assetId: `asset-${sequence}`, naturalW: 1 + integer(3000), naturalH: 1 + integer(2000) } }); count('image'); return; }
    }
    if (action === 11) { client.transact(() => { for (const e of all.slice(0, 3)) client.update(e.id, { x: coordinate(), y: coordinate() }); }); count('gesture'); return; }
    client.update(element.id, { x: coordinate(), y: coordinate() }); count('position');
  }
  for (let pair = 0; pair < 10_000; pair++) {
    const a = integer(3), b = (a + 1 + integer(2)) % 3;
    operation(clients[a]!, pair * 2); operation(clients[b]!, pair * 2 + 1);
    for (let round = 0; outbound.length; round++) {
      if (round > 20) throw new Error(`Cleanup never settles at pair ${pair}`);
      const batch = outbound.splice(0); if (random() > .5) batch.reverse();
      for (let target = 2; target >= 0; target--) for (const message of batch) if (target !== message.source) {
        Y.applyUpdate(clients[target]!.doc, message.update, NETWORK); deliveredUpdates++;
        if (pair % 17 === 0) { Y.applyUpdate(clients[target]!.doc, message.update, NETWORK); deliveredUpdates++; }
      }
    }
    let expected = '', rawExpected = '';
    clients.forEach((client, index) => {
      let elements: Element[];
      try { elements = client.readAll(); } catch (error) { throw new Error(`Seed ${SEED}, pair ${pair}, actor ${client.actor}: ${String(error)}`, { cause: error }); }
      const map = new Map(elements.map(e => [e.id, e]));
      for (const element of elements) {
        assertValidElement(element); const bounds = getElementBounds(element, map);
        if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w < 0 || bounds.h < 0) throw new Error(`Invalid derived bounds at pair ${pair}`);
        validatedElements++;
      }
      // Raw entries originate from the same encoded Yjs JSON values. Exact JSON comparison also
      // checks array and object-property ordering, and avoids recursively sorting retained history.
      const value = canonical(elements), raw = JSON.stringify([...client.writers.entries()].filter(([, writer]) => writer.records.length > 0).map(([actor, writer]) => [actor, writer.records.toJSON()]).sort(([a], [b]) => String(a).localeCompare(String(b))));
      if (index === 0) { expected = value; rawExpected = raw; }
      else if (value !== expected || raw !== rawExpected) throw new Error(`Seed ${SEED}, pair ${pair}, actor ${client.actor}: divergence`);
      const clock = client.own.kv.get(CLOCK_KEY)?.stamp.clock ?? 0;
      if (clock < clocks[index]!) throw new Error(`Clock decreased at pair ${pair}`);
      clocks[index] = clock;
      if (pair % 200 === 0) client.undoManager.clear();
    });
    if ((pair + 1) % 1000 === 0) console.log(JSON.stringify({ candidate: 'writer-owned-y-keyvalue', completedPairs: pair + 1, durationMs: Math.round(performance.now() - started) }));
  }
  expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(20_000);
  expect(Object.keys(counts).sort()).toEqual(['binding', 'create', 'delete', 'gesture', 'image', 'move', 'order', 'position', 'redo', 'resize', 'rotate', 'stroke', 'style', 'text', 'undo'].sort());
  const result = { candidate: 'writer-owned-y-keyvalue', seed: SEED, concurrentPairs: 10_000, clients: 3, operations: 20_000, invalidElements: 0, divergentPairs: 0, validatedElements, deliveredUpdates, operationCounts: counts, durationMs: Math.round(performance.now() - started) };
  mkdirSync('spikes/model-kv/reports', { recursive: true }); writeFileSync('spikes/model-kv/reports/writer-fuzz.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result)); clients.forEach(client => client.destroy());
// This exhaustive oracle serializes all retained raw records after every pair.
// The first complete run took 585,731ms; timeout is test infrastructure, not a product latency gate.
}, 900_000);
