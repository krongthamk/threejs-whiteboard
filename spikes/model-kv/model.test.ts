import * as Y from 'yjs';
import { expect, it } from 'vitest';
import { KvBoardDocument } from './model.js';

export const NETWORK = Symbol('network');
export function replicas(source: KvBoardDocument, count = 2): KvBoardDocument[] {
  return Array.from({ length: count }, (_, i) => {
    const doc = new Y.Doc(); doc.clientID = i + 1;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc), NETWORK);
    return new KvBoardDocument(doc);
  });
}
export function converge(clients: KvBoardDocument[]): void {
  for (let round = 0; round < 10; round++) {
    const snapshots = clients.map(client => Y.encodeStateAsUpdate(client.doc));
    for (let destination = 0; destination < clients.length; destination++) for (let source = clients.length - 1; source >= 0; source--) {
      if (source !== destination) Y.applyUpdate(clients[destination]!.doc, snapshots[source]!, NETWORK);
    }
    const first = JSON.stringify(clients[0]!.records.toArray());
    if (clients.every(client => JSON.stringify(client.records.toArray()) === first)) return;
  }
  throw new Error('Replicas did not reach the same raw array state after cleanup');
}
function pair(): KvBoardDocument[] {
  const source = new KvBoardDocument(); source.create('rect', { id: 'shape' });
  const pair = replicas(source); source.destroy(); return pair;
}

it('merges independent move/recolor and keeps peer color through undo', () => {
  const [a, b] = pair() as [KvBoardDocument, KvBoardDocument];
  a.move(['shape'], { x: 75, y: 20 }); b.updateStyle(['shape'], { fill: '#ff0000' }); converge([a, b]);
  expect(a.read('shape')).toMatchObject({ x: 75, y: 20, style: { fill: '#ff0000' } });
  a.undoManager.undo(); converge([a, b]);
  expect(a.read('shape')).toMatchObject({ x: 0, y: 0, style: { fill: '#ff0000' } });
  a.destroy(); b.destroy();
});

it('keeps a causally newer peer write when undoing the same local field', () => {
  const [a, b] = pair() as [KvBoardDocument, KvBoardDocument];
  a.updateStyle(['shape'], { fill: '#ff0000' }); converge([a, b]);
  b.updateStyle(['shape'], { fill: '#0000ff' }); converge([a, b]);
  a.undoManager.undo(); converge([a, b]);
  expect(a.read('shape')!.style.fill).toBe('#0000ff');
  a.destroy(); b.destroy();
});

it('restores the competing peer value when undoing the concurrent winner', () => {
  const [a, b] = pair() as [KvBoardDocument, KvBoardDocument];
  a.updateStyle(['shape'], { fill: '#ff0000' }); b.updateStyle(['shape'], { fill: '#0000ff' }); converge([a, b]);
  const winner = a.read('shape')!.style.fill === '#ff0000' ? a : b;
  const expected = winner === a ? '#0000ff' : '#ff0000';
  winner.undoManager.undo(); converge([a, b]);
  expect(a.read('shape')!.style.fill).toBe(expected);
  a.destroy(); b.destroy();
});

it('undo deletion restores the concurrent peer move and leaves no orphan fields', () => {
  const [a, b] = pair() as [KvBoardDocument, KvBoardDocument];
  a.delete('shape'); b.move(['shape'], { x: 75, y: 20 }); converge([a, b]);
  expect(a.readAll()).toEqual([]); expect(a.records.length).toBe(0);
  a.undoManager.undo(); converge([a, b]);
  expect(a.read('shape')).toMatchObject({ x: 75, y: 20 });
  a.undoManager.redo(); converge([a, b]); expect(a.readAll()).toEqual([]);
  a.undoManager.undo(); converge([a, b]); expect(a.read('shape')).toMatchObject({ x: 75, y: 20 });
  a.destroy(); b.destroy();
});

it('concurrent same-ID creation with different types never mixes generations', () => {
  const seed = new KvBoardDocument(); const [a, b] = replicas(seed) as [KvBoardDocument, KvBoardDocument]; seed.destroy();
  a.transact(() => { a.create('text', { id: 'collision', props: { text: 'Text', align: 'left', autoSize: true } }); a.update('collision', { props: { text: 'Updated', align: 'right', autoSize: true } }); });
  b.transact(() => { b.create('stroke', { id: 'collision', props: { points: [0, 0, .5, 10, 10, .8], simplified: true } }); b.move(['collision'], { x: 25, y: 25 }); });
  converge([a, b]);
  expect(a.readAll()).toEqual(b.readAll()); expect(a.readAll()).toHaveLength(1);
  expect(['text', 'stroke']).toContain(a.read('collision')!.type);
  a.destroy(); b.destroy();
});

it('groups create plus multiple updates in one transaction and undo step', () => {
  const board = new KvBoardDocument();
  board.transact(() => { board.create('rect', { id: 'a' }); board.update('a', { x: 30 }); board.update('a', { y: 60 }); });
  expect(board.read('a')).toMatchObject({ x: 30, y: 60 }); expect(board.undoManager.undoStack).toHaveLength(1);
  board.undoManager.undo(); expect(board.readAll()).toEqual([]);
  board.destroy();
});
