import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { BoardDocument, createElement, elementToYMap, readElement } from '../src/index.js';

describe('bounded element text', () => {
  it.each(['text', 'sticky'] as const)('accepts 50,000 UTF-16 units and rejects 50,001 in %s creation, add and read', type => {
    const text = 'x'.repeat(49_998) + '😀';
    const valid = createElement(type, { props: { text, align: 'left', autoSize: false } });
    expect(valid.props.text.length).toBe(50_000);
    expect(() => createElement(type, { props: { ...valid.props, text: text + 'x' } })).toThrow(/50,000/);
    const board = new BoardDocument(), before = Y.encodeStateAsUpdate(board.doc);
    expect(() => board.add({ ...valid, props: { ...valid.props, text: text + 'x' } })).toThrow(/50,000/);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    const doc = new Y.Doc(), map = elementToYMap(valid); doc.getMap('elements').set(valid.id, map);
    map.set('props', { ...valid.props, text: text + 'x' }); expect(() => readElement(map)).toThrow(/50,000/);
    doc.destroy(); board.destroy();
  });

  it('rejects an oversized merged update atomically without writes or undo history', () => {
    const board = new BoardDocument(), rect = board.create('rect', { id: 'rect' });
    const text = board.create('text', { id: 'text' }); board.undoManager.clear();
    const before = Y.encodeStateAsUpdate(board.doc), updates = vi.fn(); board.doc.on('update', updates);
    expect(() => board.updateMany([{ id: rect.id, patch: { x: 20 } }, { id: text.id, patch: { props: { ...text.props, text: 'x'.repeat(50_001) } } }])).toThrow(/50,000/);
    expect(board.read('rect')).toEqual(rect); expect(board.read('text')).toEqual(text);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(updates).not.toHaveBeenCalled();
    expect(board.undoManager.undoStack).toHaveLength(0); board.destroy();
  });
});
