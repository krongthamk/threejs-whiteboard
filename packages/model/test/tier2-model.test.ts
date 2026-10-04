import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { BoardDocument, assertValidElement, createElement, elementToYMap, readElement } from '../src/index.js';

describe('tier 2 model regressions', () => {
  it('exposes the same next index without deserializing the board after edits, deletion, remote changes and pending writes', () => {
    const board = new BoardDocument();
    const assertNext = () => {
      const expected = generateKeyBetween(board.readAll().at(-1)?.index ?? null, null);
      const read = vi.spyOn(board, 'read');
      expect(board.nextIndex()).toBe(expected);
      expect(read).not.toHaveBeenCalled(); read.mockRestore();
    };
    assertNext(); board.create('rect', { id: 'a' }); board.create('rect', { id: 'b' }); assertNext();
    board.update('a', { index: 'a9' }); assertNext(); board.delete('a'); assertNext();
    board.transact(() => { board.create('rect', { id: 'pending' }); assertNext(); board.update('pending', { index: 'b00' }); assertNext(); });
    const remote = new BoardDocument(); remote.create('rect', { id: 'remote', index: 'c000' });
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(remote.doc)); assertNext();
    board.undoManager.undo(); assertNext(); board.undoManager.redo(); assertNext();
    remote.destroy(); board.destroy();
  });

  it.each(['id', 'text', 'font', 'asset', 'binding', 'extra-key'])('rejects lone UTF-16 surrogates in every string position (%s) before writing', location => {
    const board = new BoardDocument(), element = createElement('text', { id: 'good', props: { text: '😀 ภาษาไทย 日本語', autoSize: true, align: 'left' } });
    const bad = structuredClone(element);
    if (location === 'id') bad.id = 'x\ud83dy';
    else if (location === 'text') bad.props.text = 'x\ud83dy';
    else if (location === 'font') bad.style.fontFamily = 'x\ud83dy';
    else if (location === 'asset') Object.assign(bad, { type: 'image', props: { assetId: 'x\ud83dy', naturalW: 1, naturalH: 1 } });
    else if (location === 'binding') Object.assign(bad, { type: 'connector', props: { start: { elementId: 'x\ud83dy', nx: 0, ny: 0, fallback: { x: 0, y: 0 } }, end: { x: 0, y: 0 }, kind: 'straight' } });
    else Object.defineProperty(bad.style, 'x\ud83dy', { enumerable: true, value: 'value' });
    const before = Y.encodeStateAsUpdate(board.doc);
    expect(() => board.add(bad)).toThrow(/UTF-16/);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    board.add(element); const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(board.doc));
    const replica = new BoardDocument(peer); expect(replica.readAll()).toEqual(board.readAll()); replica.destroy(); board.destroy();
  });

  it('rejects overflowing derived geometry on create, raw add, read and merged update with no partial multi-update', () => {
    const board = new BoardDocument(); const stroke = board.create('stroke', { id: 'stroke' }); const rect = board.create('rect', { id: 'rect' });
    const points = [-1e9, 0, .5, 1e9, 0, .5];
    expect(() => createElement('stroke', { props: { points, simplified: false } })).toThrow(/geometry/);
    expect(() => board.add({ ...stroke, id: 'raw', props: { points, simplified: false } })).toThrow(/geometry/);
    const map = elementToYMap(stroke), doc = new Y.Doc(); doc.getMap('elements').set('stroke', map); map.set('props', { points, simplified: false });
    expect(() => readElement(map)).toThrow(/geometry/);
    const before = Y.encodeStateAsUpdate(board.doc), undo = board.undoManager.undoStack.length;
    expect(() => board.updateMany([{ id: rect.id, patch: { x: 8 } }, { id: stroke.id, patch: { props: { points, simplified: false } } }])).toThrow(/geometry/);
    expect(board.read('rect')!.x).toBe(0); expect(board.read('stroke')).toEqual(stroke);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(undo);
    expect(() => board.update(stroke.id, { props: { points: [1e308, 0, .5, -1e308, 0, .5], simplified: false } })).toThrow();
    doc.destroy(); board.destroy();
  });

  it('bounds geometry, stroke points, connector coordinates and font size while allowing limits', () => {
    const element = createElement('rect', { x: -1e9, y: 1e9, w: 1e9, h: 1e9, style: { fontSize: 1024 } });
    expect(() => assertValidElement(element)).not.toThrow();
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(() => assertValidElement({ ...element, [key]: 1e9 + 1 })).toThrow();
    expect(() => createElement('text', { style: { fontSize: 1025 } })).toThrow();
    expect(() => createElement('connector', { props: { start: { x: 1e9 + 1, y: 0 }, end: { x: 0, y: 0 }, kind: 'straight' } })).toThrow();
    expect(() => createElement('connector', { props: { start: { elementId: 'a', nx: 0, ny: 0, fallback: { x: 0, y: -1e9 - 1 } }, end: { x: 0, y: 0 }, kind: 'curve' } })).toThrow();
  });

  it.each(['undo', 'redo'] as const)('blocks %s before writer identity on foreign schemas without an emitted update or history change', operation => {
    const board = new BoardDocument(); board.create('rect', { id: 'shape' });
    if (operation === 'redo') board.undoManager.undo();
    const remote = new Y.Doc(); Y.applyUpdate(remote, Y.encodeStateAsUpdate(board.doc)); remote.getMap('meta').set('schemaVersion', 99);
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(remote));
    const before = Y.encodeStateAsUpdate(board.doc), history = [board.undoManager.undoStack.length, board.undoManager.redoStack.length], update = vi.fn(); board.doc.on('update', update);
    expect(() => board.undoManager[operation]()).toThrow('Unsupported board schema 99');
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(update).not.toHaveBeenCalled();
    expect([board.undoManager.undoStack.length, board.undoManager.redoStack.length]).toEqual(history);
    board.doc.clientID = board.doc.clientID + 1;
    expect(() => board.undoManager[operation]()).toThrow('Unsupported board schema 99');
    board.destroy(); remote.destroy();
  });
});

it('deletes strokes without a full-board projection and maintains connector dependencies through update, remote sync and undo', () => {
  const board = new BoardDocument();
  const a = board.create('rect', { id: 'a', x: 10 }), b = board.create('rect', { id: 'b', x: 200 });
  board.create('stroke', { id: 'erased' });
  const binding = (elementId: string) => ({ elementId, nx: .5, ny: .5, fallback: { x: -100, y: -100 } });
  const connector = board.create('connector', { id: 'connector', props: { start: binding('a'), end: { x: 0, y: 0 }, kind: 'straight' } });
  board.update(connector.id, { props: { ...connector.props, start: binding('b') } });
  const peer = new BoardDocument(); Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(board.doc));
  peer.update(connector.id, { props: { ...connector.props, start: binding('a') } }); Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(peer.doc));
  const readAll = vi.spyOn(board, 'readAll'), read = vi.spyOn(board, 'read');
  board.delete('erased'); expect(readAll).not.toHaveBeenCalled(); expect(read.mock.calls).toEqual([['erased'], ['erased']]);
  board.delete('b'); expect(board.read('connector')!.props).toMatchObject({ start: binding('a') });
  board.delete('a'); expect(board.read('connector')!.props).toMatchObject({ start: { x: a.x + a.w / 2, y: a.y + a.h / 2 } });
  expect(readAll).not.toHaveBeenCalled();
  board.undoManager.undo(); expect(board.read('a')).toEqual(a); expect(board.read('connector')!.props).toMatchObject({ start: binding('a') });
  board.delete('a'); expect(board.read('connector')!.props).toMatchObject({ start: { x: a.x + a.w / 2, y: a.y + a.h / 2 } });
  expect(readAll).not.toHaveBeenCalled(); expect(board.read('b')).toBeUndefined(); peer.destroy(); board.destroy();
});

it('updates connector dependencies before deleting a retargeted endpoint in the same outer transaction', () => {
  const board = new BoardDocument(); board.create('rect', { id: 'old' }); const target = board.create('rect', { id: 'new', x: 300 });
  const binding = (elementId: string) => ({ elementId, nx: .5, ny: .5, fallback: { x: -10, y: -10 } });
  const connector = board.create('connector', { id: 'connector', props: { start: binding('old'), end: { x: 0, y: 0 }, kind: 'straight' } });
  board.transact(() => {
    board.update(connector.id, { props: { ...connector.props, start: binding('new') } });
    board.delete('new');
  });
  expect(board.read('connector')!.props).toMatchObject({ start: { x: target.x + target.w / 2, y: target.y + target.h / 2 } });
  board.undoManager.undo(); expect(board.read('new')).toEqual(target);
  expect(board.read('connector')!.props).toMatchObject({ start: binding('old') });
  board.destroy();
});

it('rejects huge stroke expansion that produces infinite SVG dimensions or NaN stroke bounds', () => {
  for (const type of ['rect', 'stroke'] as const) {
    expect(() => createElement(type, { style: { strokeWidth: 1e308 } })).toThrow(/style values/);
    const board = new BoardDocument(); board.create(type, { id: 'element' });
    const before = Y.encodeStateAsUpdate(board.doc);
    expect(() => board.updateStyle(['element'], { strokeWidth: 1e308 })).toThrow(/style values/);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); board.destroy();
  }
});

it('validates the final staged geometry when a batch contains repeated element IDs', () => {
  const board = new BoardDocument(); const stroke = board.create('stroke', { id: 'stroke' });
  // The 50k text cap makes the old 800k-line overflow trigger invalid input.
  // Bounded stroke coordinates still prove validation of the final staged state:
  // intermediate width 2e9 is invalid, but the final whole-props replacement is safe.
  const invalid = { points: [-1e9, 0, .5, 1e9, 0, .5], simplified: false };
  const valid = { points: [-1e9, 0, .5, 0, 0, .5], simplified: false };
  expect(() => board.updateMany([{ id: stroke.id, patch: { props: invalid } }, { id: stroke.id, patch: { props: valid } }])).not.toThrow();
  const accepted = board.read(stroke.id); expect(accepted).toMatchObject({ w: 1e9, props: valid });
  const before = Y.encodeStateAsUpdate(board.doc), history = board.undoManager.undoStack.length, updates = vi.fn(); board.doc.on('update', updates);
  expect(() => board.updateMany([{ id: stroke.id, patch: { props: valid } }, { id: stroke.id, patch: { props: invalid } }])).toThrow(/geometry/);
  expect(board.read(stroke.id)).toEqual(accepted); expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
  expect(updates).not.toHaveBeenCalled(); expect(board.undoManager.undoStack).toHaveLength(history); board.destroy();
});
