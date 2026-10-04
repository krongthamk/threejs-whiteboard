import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { BoardDocument, bindToElement, createElement, type Element } from '../src/index.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('native element IDs', () => {
  it('creates unique UUIDs through both the factory and board creation', () => {
    const board = new BoardDocument();
    const ids = Array.from({ length: 20 }, () => createElement('rect').id)
      .concat(Array.from({ length: 20 }, () => board.create('ellipse').id));
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
    board.destroy();
  });

  it('preserves supplied IDs and the historical fixture IDs through persistence', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../server/test/fixtures/schema2-pre-f1.expected.json', import.meta.url), 'utf8')) as { elements: Element[] };
    const board = new BoardDocument();
    for (const element of fixture.elements) {
      expect(createElement(element.type, element).id).toBe(element.id);
      board.add(element);
    }
    expect(createElement('rect', { id: 'caller-supplied-id' }).id).toBe('caller-supplied-id');
    const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(board.doc));
    const restored = new BoardDocument(doc);
    expect(restored.readAll()).toEqual(fixture.elements);
    board.destroy(); restored.destroy();
  });

  it('duplicates groups with new unique UUIDs and remaps bindings to the copied targets', () => {
    const board = new BoardDocument();
    const a = board.create('rect', { id: 'supplied-a' });
    const b = board.create('ellipse', { id: 'supplied-b', x: 300 });
    const connector = board.create('connector', { id: 'supplied-connector', props: {
      start: bindToElement(a, 1, .5), end: bindToElement(b, 0, .5), kind: 'straight',
    } });
    board.undoManager.clear();
    const copies = board.duplicate([a.id, b.id, connector.id]);
    for (const id of copies) expect(id).toMatch(UUID_V4);
    expect(new Set([...copies, a.id, b.id, connector.id]).size).toBe(6);
    expect(board.read(copies[2]!)!.props).toMatchObject({ start: { elementId: copies[0] }, end: { elementId: copies[1] } });
    expect(board.read(connector.id)).toEqual(connector);
    board.undoManager.undo();
    expect(board.readAll().map(element => element.id)).toEqual([a.id, b.id, connector.id]);
    board.destroy();
  });
});
