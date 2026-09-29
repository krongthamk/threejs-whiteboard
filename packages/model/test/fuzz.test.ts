import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { assertValidElement, bindToElement, getElementBounds, LOCAL_ORIGIN, resolveConnectorEndpoints, type Element, type ElementType } from '../src/index.js';
import { BoardDocument, WRITER_PREFIX, CLOCK_KEY } from '../src/document.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const SEED = 0x51a7e;
function rawState(client: BoardDocument): string {
  return JSON.stringify([...client.doc.share.keys()].filter(name => name.startsWith(WRITER_PREFIX)).sort().flatMap(name => { const array = client.doc.getArray(name); return array.length ? [[name, array.toArray()]] : []; }));
}
function rng(seed: number): () => number {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n; return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
const types: readonly ElementType[] = ['rect', 'ellipse', 'sticky', 'text', 'stroke', 'connector', 'image'];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

it('S2: 10,000 seeded concurrent operation pairs across three clients converge with zero invalid elements', () => {
  const started = performance.now(), random = rng(SEED);
  const integer = (n: number) => Math.floor(random() * n);
  const choose = <T>(items: readonly T[]): T => items[integer(items.length)]!;
  const coordinate = () => integer(2000) - 1000;
  const base = new BoardDocument();
  for (let i = 0; i < 28; i++) base.create(types[i % types.length]!, { id: `base-${i}`, x: i * 20, y: i * 10 });
  const snapshot = Y.encodeStateAsUpdate(base.doc);
  const clients = [1, 2, 3].map(clientID => { const doc = new Y.Doc(); doc.clientID = clientID; Y.applyUpdate(doc, snapshot, 'network'); return new BoardDocument(doc); });
  base.destroy();
  const outbound: Uint8Array[][] = [[], [], []];
  clients.forEach((client, i) => client.doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'network') outbound[i]!.push(update); }));
  const counts: Record<string, number> = {};
  const trace: { sequence: number; client: number; action: string; selected: string; state: unknown }[] = [];
  let currentSequence = -1, currentClient = -1, currentSelected = '';
  let validated = 0, delivered = 0; const clocks = [0, 0, 0];
  const count = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
    if (process.env.S2_DEBUG) {
      trace.push({ sequence: currentSequence, client: currentClient, action: name, selected: currentSelected, state: clients.find(client => client.doc.clientID === currentClient)!.readAll() });
      if (trace.length > 10) trace.shift();
    }
  };

  function operation(client: BoardDocument, sequence: number): void {
    const all = client.readAll();
    const element = choose(all);
    currentSequence = sequence; currentClient = client.doc.clientID; currentSelected = element?.id ?? '';
    const type = choose(types);
    const action = integer(15);
    if (action === 13 && client.undoManager.undoStack.length) { client.undoManager.undo(); count('undo'); return; }
    if (action === 14 && client.undoManager.redoStack.length) { client.undoManager.redo(); count('redo'); return; }
    if (all.length < 10 || action === 0 && all.length < 48) {
      client.create(type, { id: `new-${sequence}`, x: coordinate(), y: coordinate() }); count('create'); return;
    }
    if (action === 1 && all.length > 10) { client.delete(element.id); count('delete'); return; }
    if (action === 2) { client.move([element.id], { x: integer(41) - 20, y: integer(41) - 20 }); count('move'); return; }
    if (action === 3) { client.updateStyle([element.id], { fill: `#${integer(0x1000000).toString(16).padStart(6, '0')}`, opacity: random(), strokeWidth: integer(16), fontSize: 8 + integer(50) }); count('style'); return; }
    if (action === 4) { client.update(element.id, { w: 1 + integer(500), h: 1 + integer(500) }); count('resize'); return; }
    if (action === 5) { client.update(element.id, { rotation: random() * Math.PI * 2 }); count('rotate'); return; }
    if (action === 6) { client.reorder(element.id, choose(['forward', 'backward', 'front', 'back'] as const)); count('order'); return; }
    if (action === 7) {
      const target = choose(all.filter(e => e.type === 'text' || e.type === 'sticky'));
      if (target) { client.update(target.id, { props: { text: `Seeded ${sequence}\nΩ中 🖊️`, align: choose(['left', 'center', 'right'] as const), autoSize: random() > 0.5 } }); count('text'); return; }
    }
    if (action === 8) {
      const target = choose(all.filter(e => e.type === 'stroke'));
      if (target) { const points = Array.from({ length: 1 + integer(15) }, () => [coordinate(), coordinate(), random()]).flat(); client.update(target.id, { props: { points, simplified: random() > 0.5 } }); count('stroke'); return; }
    }
    if (action === 9) {
      const target = choose(all.filter(e => e.type === 'connector'));
      const anchor = choose(all.filter(e => e.type !== 'connector'));
      if (target && anchor) { client.update(target.id, { props: { start: bindToElement(anchor, random(), random()), end: { x: coordinate(), y: coordinate() }, kind: choose(['straight', 'elbow', 'curve'] as const) } }); count('binding'); return; }
    }
    if (action === 10) {
      const target = choose(all.filter(e => e.type === 'image'));
      if (target) { client.update(target.id, { props: { assetId: `asset-${sequence}`, naturalW: 1 + integer(3000), naturalH: 1 + integer(2000) } }); count('image'); return; }
    }
    if (action === 11) {
      client.transact(() => { for (const target of all.slice(0, 3)) client.update(target.id, { x: coordinate(), y: coordinate() }); }); count('multi-element gesture'); return;
    }
    client.update(element.id, { x: coordinate(), y: coordinate() }); count('position');
  }

  function assertSemanticState(client: BoardDocument, pair: number): Element[] {
    let elements: Element[];
    try { elements = client.readAll(); } catch (error) {
      if (process.env.S2_DEBUG) console.log(JSON.stringify(trace));
      throw new Error(`Seed ${SEED}; pair ${pair}; client ${client.doc.clientID}: ${String(error)}`, { cause: error });
    }
    const map = new Map(elements.map(e => [e.id, e]));
    // read() validates the complete raw base+override projection before deriving geometry.
    for (const element of elements) {
      assertValidElement(element);
      if (element.id === '' || map.size !== elements.length) throw new Error(`pair ${pair}: invalid identity`);
      if (element.type === 'stroke') {
        const xs = element.props.points.filter((_, i) => i % 3 === 0), ys = element.props.points.filter((_, i) => i % 3 === 1);
        if (element.x !== Math.min(...xs) || element.y !== Math.min(...ys) || element.w !== Math.max(...xs) - Math.min(...xs) || element.h !== Math.max(...ys) - Math.min(...ys)) throw new Error(`pair ${pair}: stale stroke geometry`);
      }
      if (element.type === 'connector') {
        for (const point of resolveConnectorEndpoints(element, map)) if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`pair ${pair}: invalid resolved endpoint`);
      }
      // Bounds exercise coherent geometry independently of raw field validation.
      const box = getElementBounds(element, map);
      if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w < 0 || box.h < 0) throw new Error(`pair ${pair}: invalid bounds`);
      validated++;
    }
    return elements;
  }

  for (let pair = 0; pair < 10_000; pair++) {
    const a = integer(3), b = (a + 1 + integer(2)) % 3;
    operation(clients[a]!, pair * 2); operation(clients[b]!, pair * 2 + 1);
    // Deliver duplicate/reordered provider packets, including YKeyValue cleanup updates, until quiescence.
    for (let round = 0; outbound.some(updates => updates.length); round++) {
      if (round > 20) throw new Error(`pair ${pair}: cleanup did not settle`);
      const messages = outbound.flatMap((updates, source) => updates.splice(0).map(update => ({ source, update })));
      if (random() > 0.5) messages.reverse();
      const order = pair % 2 === 0 ? [0, 2, 1] : [2, 1, 0];
      for (const destination of order) {
        const incoming = destination % 2 === 0 ? messages : [...messages].reverse();
        for (const message of incoming) if (message.source !== destination) {
          Y.applyUpdate(clients[destination]!.doc, message.update, 'network'); delivered++;
          if (pair % 17 === 0) { Y.applyUpdate(clients[destination]!.doc, message.update, 'network'); delivered++; }
        }
      }
    }
    const states = clients.map(client => assertSemanticState(client, pair));
    const expected = canonical(states[0]);
    for (let i = 1; i < 3; i++) if (canonical(states[i]) !== expected) throw new Error(`Seed ${SEED}; pair ${pair}; client ${i} diverged`);
    const rawExpected = canonical(clients[0]!.readAll());
    for (let i = 1; i < 3; i++) if (canonical(clients[i]!.readAll()) !== rawExpected) throw new Error(`Seed ${SEED}; pair ${pair}; client ${i} raw CRDT state diverged`);
    clients.forEach((client, i) => { const clock = client.own.kv.get(CLOCK_KEY)?.stamp.clock ?? 0; if (clock < clocks[i]!) throw new Error(`pair ${pair}: local clock decreased`); clocks[i] = clock; });
    if ((pair + 1) % 1000 === 0) console.log(JSON.stringify({ spike: 'S2-schema2', completedPairs: pair + 1, durationMs: Math.round(performance.now() - started) }));
    if (pair % 200 === 0) clients.forEach(client => client.undoManager.clear());
  }
  expect(Object.keys(counts).sort()).toEqual(['binding', 'create', 'delete', 'image', 'move', 'multi-element gesture', 'order', 'position', 'redo', 'resize', 'rotate', 'stroke', 'style', 'text', 'undo'].sort());
  expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(20_000);
  expect(validated).toBeGreaterThan(100_000);
  const result = { spike: 'S2-schema2', seed: SEED, concurrentPairs: 10_000, clients: 3, operations: 20_000, validatedElements: validated, invalidElements: 0, divergentPairs: 0, deliveredUpdates: delivered, operationCounts: counts, durationMs: Math.round(performance.now() - started) };
  mkdirSync('packages/model/reports', { recursive: true }); writeFileSync('packages/model/reports/s2-schema2-fuzz.json', `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result));
  clients.forEach(client => client.destroy());
}, 900_000);
