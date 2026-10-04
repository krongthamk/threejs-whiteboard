import * as Y from 'yjs';
import { expect, it } from 'vitest';
import { bindToElement } from '../src/index.js';
import { BoardDocument, CLOCK_PREFIX } from '../src/document.js';

function pair(): [BoardDocument, BoardDocument] {
  const a = new BoardDocument(); a.create('rect', { id: 's' });
  const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc), 'network');
  const b = new BoardDocument(doc); a.undoManager.clear();
  return [a, b];
}
function sync(a: BoardDocument, b: BoardDocument): void {
  const ua = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const ub = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  Y.applyUpdate(a.doc, ub, 'network'); Y.applyUpdate(b.doc, ua, 'network');
}

it('preserves concurrent geometry through local deletion restoration and repeated undo/redo', () => {
  const [a, b] = pair();
  a.delete('s'); b.move(['s'], { x: 75, y: 20 }); sync(a, b);
  a.undoManager.undo(); sync(a, b);
  expect(a.read('s')).toMatchObject({ x: 75, y: 20 });
  expect(a.readAll()).toEqual(b.readAll());
  a.undoManager.redo(); sync(a, b); expect(a.read('s')).toBeUndefined();
  a.undoManager.undo(); sync(a, b); expect(a.read('s')).toMatchObject({ x: 75, y: 20 });
  a.destroy(); b.destroy();
});

it('preserves normal same-property remote edit isolation', () => {
  const [a, b] = pair();
  a.updateStyle(['s'], { fill: '#ff0000' }); sync(a, b);
  b.updateStyle(['s'], { fill: '#0000ff' }); sync(a, b);
  a.undoManager.undo(); sync(a, b); expect(a.read('s')?.style.fill).toBe('#0000ff');
  a.destroy(); b.destroy();
});

it('restores multiple deleted elements with coherent remote props and bindings', () => {
  const [a, b] = pair();
  const shape = a.read('s')!;
  a.create('connector', { id: 'c', props: { start: bindToElement(shape, 1, 0.5), end: { x: 400, y: 0 }, kind: 'straight' } });
  a.create('text', { id: 't', props: { text: 'Before', align: 'left', autoSize: true } });
  sync(a, b); a.undoManager.clear();
  a.delete(['s', 't']);
  b.transact(() => {
    b.move(['s'], { x: 75, y: 20 });
    b.update('t', { props: { text: 'Peer replacement', align: 'right', autoSize: false }, w: 220, h: 50 });
  });
  sync(a, b); a.undoManager.undo(); sync(a, b);
  expect(a.read('s')).toMatchObject({ x: 75, y: 20 });
  expect(a.read('t')).toMatchObject({ w: 220, h: 50, props: { text: 'Peer replacement', align: 'right', autoSize: false } });
  expect(a.read('c')).toMatchObject({ props: { start: { elementId: 's' } } });
  expect(a.readAll()).toEqual(b.readAll());
  a.destroy(); b.destroy();
});

it('releases retained local history Items when native history clears and allows GC', () => {
  const [a, b] = pair();
  a.updateStyle(['s'], { fill: '#ff0000' });
  a.updateStyle(['s'], { fill: '#0000ff' });
  b.move(['s'], { x: 75, y: 20 }); sync(a, b);
  const stack = a.undoManager.undoStack.at(-1)!;
  const retained: Y.Item[] = [], clocksOutsideHistory: Y.Item[] = [];
  a.doc.transact(transaction => Y.iterateDeletedStructs(transaction, stack.deletions, struct => {
    if (!(struct instanceof Y.Item) || !struct.deleted || struct.id.client !== a.doc.clientID) return;
    if (struct.parent === a.own.records) retained.push(struct);
    if (struct.parent === a.doc.getMap(CLOCK_PREFIX + a.actor)) clocksOutsideHistory.push(struct);
  }), 'inspection');
  expect(retained.length).toBeGreaterThanOrEqual(1);
  expect(retained.every(item => item.keep)).toBe(true);
  expect(clocksOutsideHistory.length).toBeGreaterThanOrEqual(1);
  expect(clocksOutsideHistory.every(item => !item.keep)).toBe(true);
  a.undoManager.clear();
  // Array tombstones can coalesce, so inspect the authoritative struct by ID rather than a replaced Item object.
  expect(retained.every(item => { const current = Y.getItem(a.doc.store, item.id); return !(current instanceof Y.Item) || !current.keep; })).toBe(true);
  Y.tryGc(Y.createDeleteSetFromStructStore(a.doc.store), a.doc.store, () => true);
  expect(retained.every(item => { const current = Y.getItem(a.doc.store, item.id); return current instanceof Y.GC || current.content instanceof Y.ContentDeleted; })).toBe(true);
  expect(a.read('s')).toMatchObject({ x: 75, y: 20, style: { fill: '#0000ff' } });
  expect(a.readAll()).toEqual(b.readAll());
  a.destroy(); b.destroy();
});

it('reveals a concurrent peer value when undoing the local winning same-property write', () => {
  const [a, b] = pair();
  a.updateStyle(['s'], { fill: '#ff0000' }); b.updateStyle(['s'], { fill: '#0000ff' }); sync(a, b);
  const winner = a.read('s')!.style.fill === '#ff0000' ? a : b;
  const peer = winner === a ? b : a;
  const expected = winner === a ? '#0000ff' : '#ff0000';
  winner.undoManager.undo(); sync(a, b);
  expect(winner.read('s')?.style.fill).toBe(expected);
  expect(winner.readAll()).toEqual(peer.readAll());
  winner.undoManager.redo(); sync(a, b);
  expect(winner.read('s')?.style.fill).toBe(winner === a ? '#ff0000' : '#0000ff');
  a.destroy(); b.destroy();
});
