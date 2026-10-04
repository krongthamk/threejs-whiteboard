import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { assertValidElement, BoardDocument, createElement, elementToYMap, MAX_TEXT_LENGTH, readElement, SCHEMA_VERSION, textBlock, textLayout, type Element, type ShapeTextProps } from '../src/index.js';

const block: ShapeTextProps = { text: 'Label', align: 'center', autoSize: false, verticalAlign: 'middle' };
function shape(type: 'rect' | 'ellipse', props: Partial<ShapeTextProps> = {}, box: { w?: number; h?: number } = {}) {
  return createElement(type, { w: 200, h: 100, ...box, style: { fontSize: 24 }, props: { ...block, ...props } });
}
function replica(board: BoardDocument): BoardDocument {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(board.doc), 'network'); return new BoardDocument(doc);
}
function merge(a: BoardDocument, b: BoardDocument): void {
  const aState = Y.encodeStateAsUpdate(a.doc), bState = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, bState, 'network'); Y.applyUpdate(b.doc, aState, 'network');
}

describe('F1.1 shape text model', () => {
  it.each(['rect', 'ellipse'] as const)('accepts and round-trips a complete %s text block without changing its box', type => {
    const element = { ...createElement(type, { id: type, w: 200, h: 100 }),
      props: { ...block, text: 'Shape\nlabel' } };
    expect(() => assertValidElement(element)).not.toThrow();
    assertValidElement(element);
    const doc = new Y.Doc(); const map = elementToYMap(element); doc.getMap('elements').set(element.id, map);
    expect(readElement(map)).toEqual(element);
    const created = createElement(type, element);
    expect(created).toEqual(element); doc.destroy();
  });

  it('centers a rectangle label within the padded content box', () => {
    expect(textLayout(shape('rect'))).toMatchObject({ text: 'Label', verticalOffset: 23 });
  });

  it('exposes a shape-only setter for atomic props updates', () => {
    const board = new BoardDocument(); const shape = board.create('rect');
    expect(board.setShapeText(shape.id, 'New label')).toBe(true);
    expect(board.read(shape.id)!.props).toEqual({ text: 'New label', align: 'center', autoSize: false, verticalAlign: 'middle' });
    board.destroy();
  });

  it('keeps empty shape defaults and schema 2, and exposes only supported text blocks', () => {
    expect(SCHEMA_VERSION).toBe(2);
    const board = new BoardDocument(); expect(board.meta.get('schemaVersion')).toBe(2);
    for (const type of ['rect', 'ellipse'] as const) {
      const element = createElement(type); expect(element.props).toEqual({}); expect(textBlock(element)).toBeNull();
      expect(textLayout(element)).toEqual({ text: '', lines: [], sourceToRendered: [0], renderedToSource: [0] });
    }
    expect(textBlock(createElement('text'))).toMatchObject({ insetX: 0, insetY: 0, verticalAlign: 'top' });
    expect(textBlock(createElement('sticky'))).toMatchObject({ insetX: 12, insetY: 12, verticalAlign: 'top' });
    for (const element of [createElement('stroke'), createElement('connector'), createElement('image')]) expect(textBlock(element)).toBeNull();
    board.destroy();
  });

  it('accepts every complete horizontal/vertical alignment and explicitly empty block', () => {
    for (const type of ['rect', 'ellipse'] as const) {
      for (const align of ['left', 'center', 'right'] as const) {
        for (const verticalAlign of ['top', 'middle', 'bottom'] as const) {
          const element = shape(type, { align, verticalAlign, text: '' });
          expect(textBlock(element)).toMatchObject({ text: '', align, autoSize: false, verticalAlign });
          expect(textLayout(element).lines).toHaveLength(1);
        }
      }
    }
  });

  it.each([
    { text: 'only text' },
    { text: 'label', align: 'left', autoSize: false },
    { align: 'left', autoSize: false, verticalAlign: 'top' },
    { text: 'label', autoSize: false, verticalAlign: 'top' },
    { text: 'label', align: 'left', verticalAlign: 'top' },
    { ...block, autoSize: true },
    { ...block, autoSize: 0 },
    { ...block, align: 'justify' },
    { ...block, align: ['center'] },
    { ...block, verticalAlign: 'center' },
    { ...block, verticalAlign: ['middle'] },
    { ...block, verticalAlign: null },
    { ...block, text: 1 },
    { unknown: 'value' },
  ])('rejects incomplete or incoherent shape props %j', props => {
    for (const type of ['rect', 'ellipse'] as const) expect(() => assertValidElement({ ...createElement(type), props })).toThrow();
  });

  it('applies existing text, surrogate and JSON guards to shape blocks before mutation', () => {
    const board = new BoardDocument(); const element = board.create('ellipse'); board.undoManager.clear();
    let updates = 0; board.doc.on('update', () => updates++);
    for (const text of ['x'.repeat(MAX_TEXT_LENGTH + 1), '\ud800', '\udc00']) {
      const before = Y.encodeStateAsUpdate(board.doc);
      expect(() => board.setShapeText(element.id, text)).toThrow();
      expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.read(element.id)).toEqual(element);
      expect(board.undoManager.undoStack).toHaveLength(0);
    }
    expect(() => board.update(element.id, { props: { ...block, extra: Infinity } } as Parameters<typeof board.update>[1])).toThrow('JSON');
    expect(updates).toBe(0);
    const limitText = '🖊'.repeat(MAX_TEXT_LENGTH / 2);
    expect(board.setShapeText(element.id, limitText)).toBe(true);
    expect(board.read(element.id)!.props).toMatchObject({ text: limitText });
    expect(board.read(element.id)).toMatchObject({ w: element.w, h: element.h }); board.destroy();
  });

  it.each(['rect', 'ellipse'] as const)('sets, replaces, clears and undoes %s labels in one props register', type => {
    const board = new BoardDocument(); const element = board.create(type); board.undoManager.clear();
    let events = 0; board.doc.on('update', () => events++);
    board.setShapeText(element.id, 'first');
    expect(events).toBe(1); expect(board.undoManager.undoStack).toHaveLength(1);
    expect(board.read(element.id)!.props).toEqual({ ...block, text: 'first' });
    board.undoManager.undo(); expect(board.read(element.id)).toEqual(element);
    board.undoManager.redo(); expect(board.read(element.id)!.props).toEqual({ ...block, text: 'first' });
    board.update(element.id, { props: { ...block, text: 'configured', align: 'right', verticalAlign: 'bottom' } });
    board.undoManager.clear(); board.setShapeText(element.id, 'replacement');
    expect(board.read(element.id)!.props).toEqual({ ...block, text: 'replacement', align: 'right', verticalAlign: 'bottom' });
    expect(board.undoManager.undoStack).toHaveLength(1);
    board.undoManager.undo(); expect(board.read(element.id)!.props).toMatchObject({ text: 'configured' }); board.undoManager.redo();
    board.undoManager.clear(); board.setShapeText(element.id, '');
    expect(board.read(element.id)!.props).toEqual({}); expect(textBlock(board.read(element.id)!)).toBeNull();
    expect(board.undoManager.undoStack).toHaveLength(1);
    board.undoManager.undo(); expect(board.read(element.id)!.props).toMatchObject({ text: 'replacement', align: 'right', verticalAlign: 'bottom' });
    board.undoManager.redo(); expect(board.read(element.id)!.props).toEqual({}); board.destroy();
  });

  it('does not write to non-shapes or resurrect missing/deleted shapes', () => {
    const board = new BoardDocument(); const text = board.create('text'), rect = board.create('rect');
    board.delete(rect.id); board.undoManager.clear(); const before = Y.encodeStateAsUpdate(board.doc);
    for (const id of [text.id, rect.id, 'missing']) expect(board.setShapeText(id, 'label')).toBe(false);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0); board.destroy();
  });

  it.each([{ verticalAlign: 'top', offset: 0 }, { verticalAlign: 'middle', offset: 23 }, { verticalAlign: 'bottom', offset: 46 }] as const)(
    'positions rectangle $verticalAlign labels in the padded content box', ({ verticalAlign, offset }) => {
      const element = shape('rect', { verticalAlign });
      expect(textBlock(element)).toMatchObject({ insetX: 12, insetY: 12, verticalAlign });
      expect(textLayout(element).verticalOffset).toBe(offset);
    });

  it('uses independent ellipse insets for asymmetric dimensions, wraps inside them and preserves caret maps', () => {
    const element = shape('ellipse', { text: 'one two three four five six 日本語' }, { w: 200, h: 100 });
    const insetX = 200 * (1 - 1 / Math.SQRT2) / 2, insetY = 100 * (1 - 1 / Math.SQRT2) / 2;
    expect(textBlock(element)).toMatchObject({ insetX, insetY });
    const layout = textLayout(element);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(200 - 2 * insetX);
    expect(layout.verticalOffset).toBe((100 - 2 * insetY - layout.lines.length * 30) / 2);
    for (let at = 0; at <= element.props.text.length; at++) expect(layout.renderedToSource[layout.sourceToRendered[at]!]).toBe(at);
    const tall = textBlock(shape('ellipse', {}, { w: 40, h: 400 }))!;
    expect(tall.insetX).toBe(12); expect(tall.insetY).toBe(400 * (1 - 1 / Math.SQRT2) / 2);
  });

  it('counts blank/trailing lines and retains signed overflow offsets even in tiny boxes', () => {
    for (const type of ['rect', 'ellipse'] as const) {
      for (const [verticalAlign, factor] of [['top', 0], ['middle', .5], ['bottom', 1]] as const) {
        const element = shape(type, { text: 'A\n\n', verticalAlign }, { w: 0, h: 0 });
        const layout = textLayout(element);
        expect(layout.lines.map(line => line.text)).toEqual(['A', '', '']);
        expect(layout.verticalOffset).toBe(factor === 0 ? 0 : -90 * factor);
        expect(element).toMatchObject({ w: 0, h: 0 });
      }
    }
    expect(textLayout(shape('rect', { text: '' })).verticalOffset).toBe(23);
    const wrapped = textLayout(shape('rect', { text: 'AB' }, { w: 1, h: 100 }));
    expect(wrapped.lines.map(line => line.text)).toEqual(['A', 'B']); expect(wrapped.verticalOffset).toBe(8);
  });

  it('converges concurrent movement and labels, with independent local undo', () => {
    const a = new BoardDocument(); const element = a.create('rect', { id: 'shared', x: 10, y: 20 });
    const b = replica(a); a.undoManager.clear(); b.undoManager.clear();
    a.move([element.id], { x: 7, y: 9 }); b.setShapeText(element.id, 'Peer label'); merge(a, b);
    const expected: Element = { ...element, x: 17, y: 29, props: { ...block, text: 'Peer label' } };
    expect(a.read(element.id)).toEqual(expected); expect(b.read(element.id)).toEqual(expected);
    b.undoManager.undo(); merge(a, b);
    expect(a.read(element.id)).toEqual({ ...element, x: 17, y: 29 });
    b.undoManager.redo(); a.undoManager.undo(); merge(a, b);
    expect(a.read(element.id)).toEqual({ ...element, props: { ...block, text: 'Peer label' } });
    expect(b.readAll()).toEqual(a.readAll()); a.destroy(); b.destroy();
  });

  it('keeps text and both alignments atomic when concurrent props registers compete', () => {
    const a = new BoardDocument(); const element = a.create('ellipse', { id: 'shared' }); const b = replica(a);
    const first: ShapeTextProps = { ...block, text: 'first', align: 'left', verticalAlign: 'top' };
    const second: ShapeTextProps = { ...block, text: 'second', align: 'right', verticalAlign: 'bottom' };
    a.update(element.id, { props: first }); b.update(element.id, { props: second }); merge(a, b);
    const winner = a.read(element.id)!.props;
    expect([first, second]).toContainEqual(winner); expect(b.read(element.id)!.props).toEqual(winner);
    a.destroy(); b.destroy();
  });

  it('persists labels through a schema-2 snapshot and logged update replay', () => {
    const original = new BoardDocument(); const element = original.create('ellipse', { id: 'stored', w: 120, h: 45 });
    const snapshot = Y.encodeStateAsUpdate(original.doc); const updates: Uint8Array[] = [];
    original.doc.on('update', update => updates.push(update)); original.setShapeText(element.id, 'Stored 日本語');
    const doc = new Y.Doc(); Y.applyUpdate(doc, snapshot); for (const update of updates) Y.applyUpdate(doc, update);
    const restored = new BoardDocument(doc); expect(restored.readAll()).toEqual(original.readAll()); expect(restored.meta.get('schemaVersion')).toBe(2);
    expect(textLayout(restored.read(element.id)!)).toEqual(textLayout(original.read(element.id)!)); original.destroy(); restored.destroy();
  });
});
