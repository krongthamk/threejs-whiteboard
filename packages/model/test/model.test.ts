import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindToElement, createElement, documentToSvg, getElementBounds, hitTestElement, resolveConnectorEndpoints, textLines } from '../src/index.js';
import { BoardDocument, WRITER_PREFIX } from '../src/document.js';

function replica(source: BoardDocument): BoardDocument {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc), 'network');
  return new BoardDocument(doc);
}
function sync(a: BoardDocument, b: BoardDocument): void {
  const ua = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const ub = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  Y.applyUpdate(a.doc, ub, 'network'); Y.applyUpdate(b.doc, ua, 'network');
}

describe('document contract', () => {
  it('lets provider-backed empty documents receive metadata without a competing constructor write', () => {
    const doc = new Y.Doc(), before = Y.encodeStateAsUpdate(doc); let updates = 0;
    doc.on('update', () => updates++);
    const board = new BoardDocument(doc, { initializeMetadata: false });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before); expect(updates).toBe(0);
    expect(board.undoManager.undoStack).toHaveLength(0); expect(board.meta.toJSON()).toEqual({});
    const server = new BoardDocument(); server.meta.set('title', 'Authoritative title'); server.create('rect', { id: 'remote' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.doc), 'network');
    expect(board.meta.get('title')).toBe('Authoritative title'); expect(board.meta.get('schemaVersion')).toBe(2);
    expect(board.readAll()).toEqual(server.readAll()); expect(board.undoManager.undoStack).toHaveLength(0);
    board.destroy(); server.destroy();
  });

  it('rejects schema1 that arrives after an initially empty provider document', () => {
    const board = new BoardDocument(new Y.Doc(), { initializeMetadata: false });
    const legacy = new Y.Doc(); legacy.getMap('meta').set('schemaVersion', 1);
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(legacy), 'network');
    const before = Y.encodeStateAsUpdate(board.doc);
    expect(() => board.readAll()).toThrow('Unsupported board schema 1');
    expect(() => board.create('rect')).toThrow('Unsupported board schema 1');
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    board.destroy(); legacy.destroy();
  });

  it('rejects a prior schema explicitly without resetting its document', () => {
    const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 1);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => new BoardDocument(doc)).toThrow('Unsupported board schema 1');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before); doc.destroy();
  });

  it('reports a new remote writer and batches its affected IDs once per transaction', () => {
    const a = new BoardDocument(), b = replica(a), changes: string[][] = [];
    const unsubscribe = a.subscribe(change => changes.push([...change.ids].sort()));
    b.transact(() => { b.create('rect', { id: 'remote-a' }); b.create('ellipse', { id: 'remote-b' }); });
    sync(a, b);
    expect(changes).toEqual([['remote-a', 'remote-b']]);
    expect(a.readAll()).toEqual(b.readAll()); unsubscribe(); a.destroy(); b.destroy();
  });

  it('keeps bulk creation, explicit indices and pending reorder consistent with the maximum', () => {
    const board = new BoardDocument();
    board.transact(() => { for (let i = 0; i < 1000; i++) board.create('rect', { id: `bulk-${i}` }); });
    const elements = board.readAll();
    expect(elements).toHaveLength(1000); expect(new Set(elements.map(element => element.index)).size).toBe(1000);
    expect(elements.at(-1)?.id).toBe('bulk-999');
    board.create('rect', { id: 'low', index: 'a0' });
    board.transact(() => { board.update('bulk-500', { index: 'z' + 'z'.repeat(26) }); board.create('rect', { id: 'highest' }); });
    expect(board.readAll().at(-1)?.id).toBe('highest');
    board.delete('highest'); board.create('rect', { id: 'next' });
    expect(board.readAll().at(-1)?.id).toBe('next');
    board.destroy();
  });

  it('merges concurrent independent move and recolor; local undo preserves peer edits', () => {
    const a = new BoardDocument(); a.create('rect', { id: 'shape' });
    const b = replica(a); a.undoManager.clear();
    a.move(['shape'], { x: 30, y: 50 }); b.updateStyle(['shape'], { fill: '#ff0000' });
    sync(a, b);
    expect(a.read('shape')).toMatchObject({ x: 30, y: 50, style: { fill: '#ff0000' } });
    expect(a.readAll()).toEqual(b.readAll());
    a.undoManager.undo(); sync(a, b);
    expect(a.read('shape')).toMatchObject({ x: 0, y: 0, style: { fill: '#ff0000' } });
    a.undoManager.redo(); sync(a, b);
    expect(b.read('shape')).toMatchObject({ x: 30, y: 50, style: { fill: '#ff0000' } });
    a.destroy(); b.destroy();
  });

  it('groups a multi-element gesture into exactly one transaction and undo step', () => {
    const board = new BoardDocument();
    board.transact(() => { board.create('rect', { id: 'a' }); board.create('ellipse', { id: 'b' }); });
    expect(board.undoManager.undoStack).toHaveLength(1);
    const changes: string[][] = [];
    const unsubscribe = board.subscribe(change => changes.push([...change.ids].sort()));
    board.move(['a', 'b'], { x: 20, y: 30 });
    expect(changes).toEqual([['a', 'b']]);
    expect(board.undoManager.undoStack).toHaveLength(2);
    board.undoManager.undo();
    expect(board.readAll().map(e => [e.x, e.y])).toEqual([[0, 0], [0, 0]]);
    board.undoManager.undo(); expect(board.readAll()).toEqual([]);
    unsubscribe(); board.destroy();
  });

  it('does not undo a causally newer peer write to the same property', () => {
    const a = new BoardDocument(); a.create('rect', { id: 'shape' });
    const b = replica(a); a.undoManager.clear();
    a.updateStyle(['shape'], { fill: '#ff0000' }); sync(a, b);
    b.updateStyle(['shape'], { fill: '#0000ff' }); sync(a, b);
    a.undoManager.undo(); sync(a, b);
    expect(a.read('shape')?.style.fill).toBe('#0000ff');
    expect(a.readAll()).toEqual(b.readAll());
    a.destroy(); b.destroy();
  });

  it('restores a deleted shape with its concurrent remote move intact', () => {
    const a = new BoardDocument(); a.create('rect', { id: 'shape' });
    const b = replica(a); a.undoManager.clear();
    a.delete('shape'); b.move(['shape'], { x: 75, y: 20 }); sync(a, b);
    expect(a.read('shape')).toBeUndefined();
    a.undoManager.undo(); sync(a, b);
    expect(a.read('shape')).toMatchObject({ x: 75, y: 20 });
    expect(a.readAll()).toEqual(b.readAll());
    a.destroy(); b.destroy();
  });

  it('does not expose mutable CRDT values through reads or retain caller input', () => {
    const board = new BoardDocument();
    const points = [1, 2, 0.5, 8, 9, 0.8];
    board.create('stroke', { id: 'stroke', props: { points, simplified: false } });
    points[0] = 1000;
    const first = board.read('stroke')!;
    first.style.fill = 'malicious';
    if (first.type === 'stroke') first.props.points[0] = 2000;
    expect(board.read('stroke')).toMatchObject({ x: 1, style: { fill: '#ffffff' }, props: { points: [1, 2, 0.5, 8, 9, 0.8] } });
    board.destroy();
  });

  it('derives stroke boxes from coherent points and auto-size text boxes from coherent text', () => {
    const a = new BoardDocument();
    a.create('stroke', { id: 's', props: { points: [1, 2, 0.5, 8, 9, 0.8], simplified: false } });
    a.create('text', { id: 't', props: { text: 'A', align: 'left', autoSize: true } });
    const b = replica(a);
    a.update('s', { x: 900, y: 800, w: 700, h: 600 });
    b.update('s', { props: { points: [-5, -7, 0.2, 22, 18, 1], simplified: true } });
    a.update('t', { w: 900, h: 700 });
    b.update('t', { props: { text: 'Changed\nText', align: 'right', autoSize: true } });
    sync(a, b);
    expect(a.read('s')).toMatchObject({ x: -5, y: -7, w: 27, h: 25, props: { simplified: true } });
    expect(a.read('t')).toMatchObject({ w: 102.78515625, h: 60, props: { text: 'Changed\nText', align: 'right' } });
    expect(a.readAll()).toEqual(b.readAll());
    a.destroy(); b.destroy();
  });

  it('detaches connectors at the latest resolved endpoint in one deletion undo step', () => {
    const board = new BoardDocument();
    const target = board.create('rect', { id: 'target', x: 10, y: 20, w: 100, h: 80 });
    board.create('connector', { id: 'c', props: { start: bindToElement(target, 1, 0.5), end: { x: 400, y: 400 }, kind: 'elbow' } });
    board.move(['target'], { x: 50, y: 70 }); board.undoManager.clear();
    board.delete('target');
    expect(board.read('c')).toMatchObject({ props: { start: { x: 160, y: 130 } } });
    expect(board.undoManager.undoStack).toHaveLength(1);
    board.undoManager.undo();
    expect(board.read('target')).toBeDefined();
    expect(board.read('c')).toMatchObject({ props: { start: { elementId: 'target' } } });
    board.destroy();
  });

  it('resolves a concurrent newly created binding after target deletion deterministically', () => {
    const a = new BoardDocument();
    const target = a.create('ellipse', { id: 'target', x: 10, y: 20, w: 100, h: 80 });
    const b = replica(a);
    a.delete('target');
    b.create('connector', { id: 'c', props: { start: bindToElement(target, 1, 0.5), end: { x: 400, y: 400 }, kind: 'straight' } });
    sync(a, b);
    const endpoints = (board: BoardDocument) => resolveConnectorEndpoints(board.read('c')!, new Map(board.readAll().map(e => [e.id, e])));
    expect(endpoints(a)).toEqual([{ x: 110, y: 60 }, { x: 400, y: 400 }]);
    expect(endpoints(a)).toEqual(endpoints(b));
    a.destroy(); b.destroy();
  });

  it('rejects invalid coherent writes and immutable type/id changes', () => {
    const board = new BoardDocument(); board.create('stroke', { id: 's' });
    expect(() => board.update('s', { props: { points: [1, 2], simplified: false } })).toThrow('stroke coherence');
    expect(() => board.update('s', { props: { points: [1, 2, 9], simplified: false } })).toThrow('stroke point');
    expect(() => board.update('s', { w: -1 })).toThrow('geometry');
    expect(() => board.update('s', { style: { ...board.read('s')!.style, opacity: 2 } })).toThrow('style values');
    expect(() => board.update('s', { type: 'text' } as never)).toThrow('Immutable');
    expect(() => board.update('s', { id: 'new' } as never)).toThrow('Immutable');
    board.destroy();
  });

  it('preserves document geometry, bindings and ordering through hard reload', () => {
    const a = new BoardDocument();
    a.create('rect', { id: 'a' }); a.create('ellipse', { id: 'b' });
    const copies = a.duplicate(['a', 'b']);
    expect(copies).toHaveLength(2);
    a.reorder('a', 'front');
    expect(a.readAll().at(-1)?.id).toBe('a');
    const b = replica(a);
    expect(b.readAll()).toEqual(a.readAll());
    expect(b.undoManager.undoStack).toHaveLength(0);
    expect([...b.doc.share.keys()].every(name => name === 'meta' || name.startsWith(WRITER_PREFIX))).toBe(true);
    expect(b.meta.get('schemaVersion')).toBe(2);
    a.destroy(); b.destroy();
  });

  it('rejects malformed JSON patches before any key, update or undo history changes', () => {
    const board = new BoardDocument();
    board.create('text', { id: 't' }); board.undoManager.clear();
    let updates = 0;
    board.doc.on('update', () => updates++);
    const before = Y.encodeStateAsUpdate(board.doc);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const invalid of [() => 1, new Date(), undefined, Infinity, BigInt(1), cycle, new Map()]) {
      expect(() => board.update('t', { x: 42, props: { text: 'valid', align: 'left', autoSize: true, extra: invalid } } as never)).toThrow();
      expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
      expect(board.undoManager.undoStack).toHaveLength(0);
    }
    expect(updates).toBe(0);
    board.destroy();
  });

  it('validates all patches before a multi-element gesture writes any field', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'a' }); board.create('rect', { id: 'b' }); board.undoManager.clear();
    const before = Y.encodeStateAsUpdate(board.doc);
    expect(() => board.updateMany([{ id: 'a', patch: { x: 100 } }, { id: 'b', patch: { w: -10 } }])).toThrow();
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(board.undoManager.undoStack).toHaveLength(0);
    board.destroy();
  });

  it('handles fractional-index collisions deterministically and can reorder out of a tie', () => {
    const board = new BoardDocument();
    board.create('rect', { id: 'a', index: 'a0' }); board.create('rect', { id: 'b', index: 'a0' }); board.create('rect', { id: 'c', index: 'a0' });
    expect(board.readAll().map(e => e.id)).toEqual(['a', 'b', 'c']);
    board.reorder('a', 'forward'); expect(board.readAll().at(-1)?.id).toBe('a');
    board.reorder('c', 'backward'); expect(board.readAll()[0]?.id).toBe('c');
    board.destroy();
  });
});

describe('shared geometry and SVG', () => {
  it('wraps text and encodes unsafe markup while preserving z order and embedded fonts', () => {
    const sticky = createElement('sticky', { id: 'sticky', w: 120, props: { text: 'one two three four', align: 'left', autoSize: false } });
    expect(textLines(sticky)).toEqual(['one two', 'three', 'four']);
    const text = createElement('text', { id: 'text', index: 'a1', props: { text: '<script>&"', align: 'left', autoSize: true } });
    const svg = documentToSvg([text, sticky], { background: null, fonts: [{ family: 'Inter', dataUrl: 'data:font/woff;base64,AA==' }] });
    expect(svg.indexOf('data-element-id="sticky"')).toBeLessThan(svg.indexOf('data-element-id="text"'));
    expect(svg).toContain('&lt;script&gt;&amp;&quot;'); expect(svg).not.toContain('<script>');
    expect(svg).toContain('@font-face'); expect(svg).toContain('data:font/woff;base64,AA==');
    expect(svg.match(/<tspan data-text-line=/g)).toHaveLength(4);
    expect(() => documentToSvg([createElement('image')], { assetUrl: () => 'javascript:alert(1)' })).toThrow('asset URL');
  });

  it('hit tests rotated geometry and actual pressure-aware stroke outlines', () => {
    const rect = createElement('rect', { x: 0, y: 0, w: 100, h: 20, rotation: Math.PI / 2 });
    expect(hitTestElement(rect, { x: 50, y: 50 }, 0)).toBe(true);
    expect(hitTestElement(rect, { x: 5, y: 10 }, 0)).toBe(false);
    const stroke = createElement('stroke', { props: { points: [0, 0, 1, 100, 0, 1], simplified: true }, style: { strokeWidth: 8 } });
    expect(hitTestElement(stroke, { x: 50, y: 0 }, 0)).toBe(true);
    expect(hitTestElement(stroke, { x: 50, y: 30 }, 0)).toBe(false);
    expect(getElementBounds(stroke).h).toBeGreaterThan(8);
  });
});
