import { expect, it } from 'vitest';
import { BoardDocument, bindToElement, contentBounds, createElement, MAX_TEXT_LENGTH, resolveBinding } from '@whiteboard/model';
import { encodeClipboard, parseClipboard, preparePastedElements, MAX_CLIPBOARD_BYTES, MAX_CLIPBOARD_ELEMENTS } from './clipboard-model.js';

it('captures external endpoints and remaps internal rotated bindings with translated fallbacks', () => {
  const target = createElement('rect', { id: 'target', x: 20, y: 30, w: 100, h: 60, rotation: Math.PI / 2, index: 'a0' });
  const outside = createElement('ellipse', { id: 'outside', x: 500, y: 200, w: 80, h: 100, index: 'a1' });
  const connector = createElement('connector', { id: 'line', index: 'a2', props: { start: bindToElement(target, 1, .5), end: bindToElement(outside, 0, .5), kind: 'elbow' } });
  target.x += 40; outside.y += 50; // Stored fallbacks are deliberately stale before copying.
  const source = [target, outside, connector], before = structuredClone(source);
  const parsed = parseClipboard(encodeClipboard('source', ['line', 'target'], source))!;
  expect(parsed.elements.map(element => element.id)).toEqual(['target', 'line']);
  const map = new Map(source.map(element => [element.id, element]));
  const originalStart = resolveBinding(connector.props.start, map), originalEnd = resolveBinding(connector.props.end, map);
  expect(parsed.elements[1]).toMatchObject({ props: { start: { elementId: 'target', fallback: originalStart }, end: originalEnd } });
  const prepared = preparePastedElements(parsed, { targetBoardId: 'other', center: { x: 1000, y: 800 }, highestIndex: 'a9', newIds: ['target-copy', 'line-copy'] });
  const pastedMap = new Map(prepared.map(element => [element.id, element])), delta = { x: prepared[0]!.x - target.x, y: prepared[0]!.y - target.y };
  const line = prepared[1]!; if (line.type !== 'connector') throw new Error('Expected connector');
  expect(line.props.start).toMatchObject({ elementId: 'target-copy', fallback: { x: originalStart.x + delta.x, y: originalStart.y + delta.y } });
  expect(resolveBinding(line.props.start, pastedMap)).toEqual({ x: originalStart.x + delta.x, y: originalStart.y + delta.y });
  expect(line.props.end).toEqual({ x: originalEnd.x + delta.x, y: originalEnd.y + delta.y });
  const bounds = contentBounds(prepared); expect(bounds.x + bounds.w / 2).toBeCloseTo(1000); expect(bounds.y + bounds.h / 2).toBeCloseTo(800);
  expect(prepared[0]!.index > 'a9').toBe(true); expect(prepared[1]!.index > prepared[0]!.index).toBe(true);
  expect(source).toEqual(before);
});

it('translates world-space stroke triples without changing pressure and requires cross-board asset mapping', () => {
  const stroke = createElement('stroke', { id: 's', index: 'a0', rotation: .3, props: { points: [-10, -20, .2, 50, 80, .9, 90, 30, .5], simplified: true } });
  const image = createElement('image', { id: 'i', x: 200, y: 100, index: 'a1', props: { assetId: 'source-asset', naturalW: 640, naturalH: 480 } });
  const parsed = parseClipboard(encodeClipboard('source', ['s', 'i'], [stroke, image]))!, before = structuredClone(parsed);
  const options = { targetBoardId: 'destination', center: { x: 300, y: 500 }, highestIndex: null, newIds: ['new-s', 'new-i'] };
  expect(() => preparePastedElements(parsed, options)).toThrow('must be copied');
  const pasted = preparePastedElements(parsed, { ...options, imageAssetIds: new Map([['source-asset', 'destination-asset']]) });
  const copiedStroke = pasted[0]!; if (copiedStroke.type !== 'stroke') throw new Error('Expected stroke');
  const dx = copiedStroke.x - stroke.x, dy = copiedStroke.y - stroke.y;
  expect(copiedStroke.props.points).toEqual(stroke.props.points.map((value, i) => i % 3 === 0 ? value + dx : i % 3 === 1 ? value + dy : value));
  expect(pasted[1]).toMatchObject({ props: { assetId: 'destination-asset', naturalW: 640, naturalH: 480 } });
  expect(parsed).toEqual(before);
  expect(preparePastedElements(parsed, { ...options, targetBoardId: 'source' })[1]).toMatchObject({ props: { assetId: 'source-asset' } });
});

it('rejects malformed recognized envelopes, duplicate identities, broken binding targets and oversized JSON', () => {
  expect(parseClipboard('ordinary copied text')).toBeNull(); expect(parseClipboard('{bad json')).toBeNull(); expect(parseClipboard('{"type":"other"}')).toBeNull();
  const rect = createElement('rect', { id: 'r' });
  const base = { type: 'whiteboard/clipboard', version: 1, sourceBoardId: 'source', elements: [rect] };
  for (const invalid of [{ ...base, version: 2 }, { ...base, sourceBoardId: '' }, { ...base, extra: true }, { ...base, elements: [] }, { ...base, elements: [rect, rect] },
    { ...base, elements: [{ ...rect, w: -1 }] }, { ...base, elements: [createElement('connector', { props: { start: bindToElement(rect, 0, 0), end: { x: 0, y: 0 }, kind: 'straight' } })] }]) {
    expect(() => parseClipboard(JSON.stringify(invalid))).toThrow('Invalid whiteboard clipboard');
  }
  expect(() => parseClipboard(' '.repeat(MAX_CLIPBOARD_BYTES + 1))).toThrow('bytes');
  expect(() => parseClipboard('中'.repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3)))).toThrow('bytes');
  expect(() => parseClipboard(JSON.stringify({ ...base, elements: Array.from({ length: MAX_CLIPBOARD_ELEMENTS + 1 }, (_, i) => ({ ...rect, id: `r-${i}` })) }))).toThrow('element count');
  expect(() => preparePastedElements(base as never, { targetBoardId: 'source', center: { x: 0, y: 0 }, highestIndex: null, newIds: ['r'] })).toThrow('differ');
  expect(() => preparePastedElements({ ...base, elements: [rect, { ...rect, id: 'r2' }] } as never, { targetBoardId: 'source', center: { x: 0, y: 0 }, highestIndex: null, newIds: ['same', 'same'] })).toThrow('unique');
});

it('prepares all values before insertion and pastes a mixed selection as one undoable gesture', () => {
  const board = new BoardDocument(); board.create('rect', { id: 'existing' }); board.undoManager.clear();
  const target = createElement('rect', { id: 'r', x: 40, y: 50 }), stroke = createElement('stroke', { id: 's', props: { points: [0, 0, .2, 100, 50, .8], simplified: false } });
  const connector = createElement('connector', { id: 'c', props: { start: bindToElement(target, 1, .5), end: { x: 400, y: 200 }, kind: 'straight' } });
  const envelope = parseClipboard(encodeClipboard('source', ['r', 's', 'c'], [target, stroke, connector]))!;
  const prepared = preparePastedElements(envelope, { targetBoardId: 'destination', center: { x: 800, y: 600 }, highestIndex: board.readAll().at(-1)!.index, newIds: ['copy-1', 'copy-2', 'copy-3'] });
  expect(board.readAll()).toHaveLength(1); let packets = 0; board.doc.on('update', () => packets++);
  board.transact(() => { for (const element of prepared) board.add(element); });
  expect(packets).toBe(1); expect(board.undoManager.undoStack).toHaveLength(1); expect(board.readAll()).toHaveLength(4);
  board.undoManager.undo(); expect(board.readAll().map(element => element.id)).toEqual(['existing']);
  board.undoManager.redo(); expect(board.readAll()).toHaveLength(4); board.destroy();
});

it('preserves source stacking when an envelope arrives with its array out of order', () => {
  const front = createElement('rect', { id: 'front', index: 'a5' }), back = createElement('ellipse', { id: 'back', index: 'a1' });
  const envelope = { type: 'whiteboard/clipboard' as const, version: 1 as const, sourceBoardId: 'source', elements: [front, back] };
  expect(parseClipboard(JSON.stringify(envelope))!.elements.map(element => element.id)).toEqual(['back', 'front']);
  const prepared = preparePastedElements(envelope, { targetBoardId: 'source', center: { x: 0, y: 0 }, highestIndex: 'b10', newIds: ['new-front', 'new-back'] });
  expect(prepared.map(element => element.id)).toEqual(['new-back', 'new-front']);
  expect(prepared[0]!.index > 'b10' && prepared[1]!.index > prepared[0]!.index).toBe(true);
});

it('rejects unpaired UTF-16 in clipboard board IDs, copied strings and destination IDs', () => {
  const rect = createElement('rect', { id: 'source' });
  const envelope = { type: 'whiteboard/clipboard' as const, version: 1 as const, sourceBoardId: 'board', elements: [rect] };
  expect(() => parseClipboard(JSON.stringify({ ...envelope, sourceBoardId: 'x\ud83dy' }))).toThrow();
  expect(() => parseClipboard(JSON.stringify({ ...envelope, elements: [{ ...rect, id: 'x\ud83dy' }] }))).toThrow();
  expect(() => encodeClipboard('x\ud83dy', ['source'], [rect])).toThrow();
  const options = { targetBoardId: 'target', center: { x: 0, y: 0 }, highestIndex: null, newIds: ['fresh'] };
  expect(() => preparePastedElements(envelope, { ...options, targetBoardId: 'x\ud83dy' })).toThrow();
  expect(() => preparePastedElements(envelope, { ...options, newIds: ['x\ud83dy'] })).toThrow();
});

it('rejects a clipboard whose bounded raw points derive an out-of-bounds stroke width', () => {
  const element = createElement('stroke', { id: 'stroke' });
  const envelope = { type: 'whiteboard/clipboard', version: 1, sourceBoardId: 'board', elements: [{ ...element, props: { ...element.props, points: [-1e9, 0, .5, 1e9, 0, .5] } }] };
  expect(() => parseClipboard(JSON.stringify(envelope))).toThrow();
});

it('round-trips labeled and canonical empty shapes across boards as one immutable, ordered paste gesture', () => {
  const rect = createElement('rect', { id: 'rect-label', index: 'a1', x: -40, y: 20, w: 220, h: 90, rotation: Math.PI / 6,
    style: { fontFamily: 'IBM Plex Mono', fontSize: 18 },
    props: { text: '  Rectangle e\u0301 👩‍💻\n\n日本語 \t\n', align: 'right', autoSize: false, verticalAlign: 'bottom' } });
  const ellipse = createElement('ellipse', { id: 'ellipse-label', index: 'a3', x: 240, y: -60, w: 180, h: 120, rotation: -Math.PI / 4,
    style: { fontFamily: 'Noto Sans JP', fontSize: 28 },
    props: { text: '\nEllipse 🇯🇵\nlabel  \n\n', align: 'left', autoSize: false, verticalAlign: 'top' } });
  const emptyRect = createElement('rect', { id: 'rect-empty', index: 'a0', x: -240, y: 80, w: 80, h: 40 });
  const emptyEllipse = createElement('ellipse', { id: 'ellipse-empty', index: 'a2', x: 120, y: 180, w: 70, h: 110 });
  const source = [ellipse, emptyRect, emptyEllipse, rect], before = structuredClone(source);
  const envelope = parseClipboard(encodeClipboard('source-board', source.map(element => element.id).reverse(), source))!;
  const ordered = [emptyRect, rect, emptyEllipse, ellipse];
  expect(envelope.elements).toEqual(ordered);
  const captured = structuredClone(envelope), board = new BoardDocument();
  try {
    board.create('rect', { id: 'destination-existing', index: 'b10' }); board.undoManager.clear();
    const newIds = ordered.map(() => crypto.randomUUID());
    expect(new Set(newIds).size).toBe(4); expect(newIds.some(id => source.some(element => element.id === id))).toBe(false);
    const prepared = preparePastedElements(envelope, { targetBoardId: 'other-board', center: { x: 900, y: 700 }, highestIndex: board.highestIndex(), newIds });
    expect(board.readAll().map(element => element.id)).toEqual(['destination-existing']);
    const delta = { x: prepared[0]!.x - ordered[0]!.x, y: prepared[0]!.y - ordered[0]!.y };
    for (const [i, original] of ordered.entries()) {
      expect(prepared[i]).toEqual({ ...original, id: newIds[i], index: prepared[i]!.index, x: original.x + delta.x, y: original.y + delta.y });
      expect(prepared[i]!.index > (i ? prepared[i - 1]!.index : 'b10')).toBe(true);
    }
    expect(prepared[0]!.props).toEqual({}); expect(prepared[2]!.props).toEqual({});
    const bounds = contentBounds(prepared); expect(bounds.x + bounds.w / 2).toBeCloseTo(900); expect(bounds.y + bounds.h / 2).toBeCloseTo(700);
    let updates = 0; board.doc.on('update', () => updates++);
    board.transact(() => { for (const element of prepared) board.add(element); });
    expect(updates).toBe(1); expect(board.undoManager.undoStack).toHaveLength(1);
    expect(board.readAll()).toEqual([board.read('destination-existing'), ...prepared]);
    board.undoManager.undo(); expect(board.readAll().map(element => element.id)).toEqual(['destination-existing']);
    board.undoManager.redo(); expect(board.readAll().slice(1)).toEqual(prepared);
    expect(source).toEqual(before); expect(envelope).toEqual(captured);
  } finally { board.destroy(); }
});

it('rejects hostile shape-label props at clipboard parsing and paste preparation', () => {
  const valid = { text: 'Label', align: 'center', autoSize: false, verticalAlign: 'middle' };
  const hostile = [{ text: 'Partial' }, { ...valid, autoSize: true }, { ...valid, verticalAlign: 'sideways' },
    { ...valid, align: ['center'] }, { ...valid, text: 'broken\ud83d' }, { ...valid, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }];
  for (const type of ['rect', 'ellipse'] as const) {
    const element = createElement(type, { id: type });
    for (const props of hostile) {
      const envelope = { type: 'whiteboard/clipboard', version: 1, sourceBoardId: 'source', elements: [{ ...element, props }] };
      expect(() => parseClipboard(JSON.stringify(envelope))).toThrow('Invalid whiteboard clipboard');
      expect(() => preparePastedElements(envelope as never, { targetBoardId: 'destination', center: { x: 0, y: 0 }, highestIndex: null, newIds: [crypto.randomUUID()] })).toThrow('Invalid whiteboard clipboard');
    }
  }
});
