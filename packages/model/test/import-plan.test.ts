import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import { BoardDocument, BoardUpdateValidator, checkUpdateResources, createElement, isImportPlanCurrent, planImport, syncFrameBytes,
  WRITER_PREFIX, type Element, type ImportBudget } from '../src/index.js';

const MB = 1024 * 1024;
function budget(board: BoardDocument, changes: Partial<ImportBudget> = {}): ImportBudget {
  return { maxUpdateBytes: 4 * MB, maxBoardBytes: 64 * MB, maxInboundBytes: 8 * MB, maxClockGrowth: 1_000_000,
    snapshotBytes: Y.encodeStateAsUpdate(board.doc).length, updateBytes: 0, stateVector: Y.encodeStateVector(board.doc), ...changes };
}
function shapes(count: number, textLength = 0): Element[] {
  return generateNKeysBetween(null, null, count).map((index, i) => createElement('rect', { id: `import-${i}`, index,
    props: textLength ? { text: 'x'.repeat(textLength), autoSize: false, align: 'center', verticalAlign: 'middle' } : {} }));
}
const options = (board: BoardDocument, changes: Partial<ImportBudget> = {}) => ({ documentName: '日本語-board', budget: budget(board, changes) });
const bytes = (board: BoardDocument) => Y.encodeStateAsUpdate(board.doc);
function capture(board: BoardDocument, work: () => void): Uint8Array[] {
  const result: Uint8Array[] = [], listener = (update: Uint8Array) => { result.push(update); };
  board.doc.on('update', listener); try { work(); } finally { board.doc.off('update', listener); } return result;
}
function captureRaw(doc: Y.Doc, work: () => void): Uint8Array[] {
  const updates: Uint8Array[] = [], listener = (update: Uint8Array) => { updates.push(update); };
  doc.on('update', listener); try { work(); } finally { doc.off('update', listener); } return updates;
}
function baselineWithHistory(): BoardDocument {
  const board = new BoardDocument();
  board.create('rect', { id: 'existing' });
  for (let i = 0; i < 100; i++) board.update('existing', { x: i });
  board.create('rect', { id: 'deleted' }); board.delete('deleted'); board.undoManager.clear(); return board;
}

describe('exact import staging and ownership', () => {
  it('stages the same actor and emits byte-identical actual adds, preserving source and live undo/clock', () => {
    const board = baselineWithHistory(), input = shapes(3, 40), source = structuredClone(input), before = bytes(board), clock = board.writerClock(), actor = board.actor;
    board.move(['existing'], { x: 1, y: 0 }); const baseline = bytes(board), baselineClock = board.writerClock(), undo = board.undoManager.undoStack.length;
    const updates = capture(board, () => {
      const plan = planImport(board, input, options(board));
      expect(plan.batches).toHaveLength(1); expect(isImportPlanCurrent(board, plan)).toBe(true);
      expect(bytes(board)).toEqual(baseline); expect(board.undoManager.undoStack).toHaveLength(undo);
      expect(board.actor).toBe(actor); expect(board.writerClock()).toBe(baselineClock); expect(baselineClock).toBeGreaterThan(clock);
      expect(input).toEqual(source); expect(plan.batches[0]!.elements[0]!.index > board.highestIndex()!).toBe(true);
      const expected = plan.batches[0]!.update;
      const emitted = capture(board, () => board.transact(() => plan.batches[0]!.elements.forEach(element => board.add(element))));
      expect(emitted).toHaveLength(1); expect(emitted[0]).toEqual(expected); expect(isImportPlanCurrent(board, plan)).toBe(false);
      expect(board.undoManager.undoStack).toHaveLength(undo + 1);
      board.undoManager.undo(); expect(board.read('import-0')).toBeUndefined(); expect(board.read('existing')!.x).toBe(100);
    });
    expect(updates).toHaveLength(2); expect(before).not.toEqual(baseline); board.destroy();
  });
  it('freezes output elements and copies update evidence so caller mutations cannot invalidate preflight', () => {
    const board = new BoardDocument(), plan = planImport(board, shapes(1, 10), options(board)), batch = plan.batches[0]!;
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(batch.elements[0]!.props)).toBe(true);
    expect(() => { batch.elements[0]!.x = 999; }).toThrow();
    const evidence = batch.update, original = evidence[0]; evidence[0] ^= 255;
    expect(batch.update[0]).toBe(original); expect(isImportPlanCurrent(board, plan)).toBe(true); board.destroy();
  });
  it('detects a delete-only baseline change even when its state vector does not advance', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'existing' });
    const plan = planImport(board, shapes(1), options(board)), vector = Y.encodeStateVector(board.doc);
    board.doc.transact(() => board.doc.getArray(WRITER_PREFIX + board.actor).delete(0));
    expect(Y.encodeStateVector(board.doc)).toEqual(vector); expect(isImportPlanCurrent(board, plan)).toBe(false); board.destroy();
  });
  it('rejects duplicate/colliding IDs and malformed later elements without live writes or undo effects', () => {
    const board = baselineWithHistory(), before = bytes(board), undo = board.undoManager.undoStack.length, clock = board.writerClock();
    const invalid = shapes(2); invalid[1]!.x = Infinity;
    for (const input of [invalid, [shapes(1)[0]!, shapes(1)[0]!], [createElement('rect', { id: 'existing' })]]) {
      expect(capture(board, () => { expect(() => planImport(board, input, options(board))).toThrow(); })).toEqual([]);
      expect(bytes(board)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(undo); expect(board.writerClock()).toBe(clock);
    }
    board.destroy();
  });
});

describe('byte, resource, storage and acknowledgement bounds', () => {
  it('counts UTF8 document names and exact varuint payload boundaries', () => {
    expect(syncFrameBytes('a', 127)).toBe(132); expect(syncFrameBytes('a', 128)).toBe(134);
    expect(syncFrameBytes('日'.repeat(43), 0, 1)).toBe(134);
    expect(() => syncFrameBytes('bad\ud800', 1)).toThrow('address');
  });
  it('rejects pending causal structs or deletions before staging', () => {
    const source = new Y.Doc(), records = source.getArray('history');
    const first = captureRaw(source, () => records.push([1]));
    const second = captureRaw(source, () => records.push([2]));
    const deleted = captureRaw(source, () => records.delete(0));
    for (const update of [second[0]!, deleted[0]!]) {
      const board = new BoardDocument(); Y.applyUpdate(board.doc, update);
      const before = bytes(board); expect(() => planImport(board, shapes(1), options(board))).toThrow('causal history');
      expect(bytes(board)).toEqual(before); board.destroy();
    }
    expect(first).toHaveLength(1); source.destroy();
  });
  it('retains one fitting gesture beyond 500 items; split batches never exceed 500 or configured count', () => {
    const board = new BoardDocument(), input = shapes(501);
    expect(planImport(board, input, options(board)).batches).toHaveLength(1);
    const split = planImport(board, input, { ...options(board, { maxUpdateBytes: 30_000 }), maxBatchElements: 80 });
    expect(split.batches.length).toBeGreaterThan(1); expect(split.batches.every(batch => batch.elements.length <= 80 && batch.frameBytes <= 30_000)).toBe(true);
    expect(split.batches.flatMap(batch => batch.elements.map(e => e.id))).toEqual(input.map(e => e.id)); board.destroy();
  });
  it('plans all 500 maximum-length labels into bounded byte batches before any live insert', () => {
    const board = new BoardDocument(), input = shapes(500, 50_000), before = bytes(board);
    const plan = planImport(board, input, options(board, { maxUpdateBytes: 2 * MB }));
    expect(plan.batches.length).toBeGreaterThan(1); expect(plan.batches.flatMap(batch => batch.elements)).toHaveLength(500);
    expect(plan.batches.every(batch => batch.frameBytes <= 2 * MB && batch.reconnectFrameBytes <= 2 * MB && batch.elements.length <= 500)).toBe(true);
    expect(bytes(board)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0); board.destroy();
  });
  it('rejects a later individually oversized element with zero live writes, rather than committing a prefix', () => {
    const board = baselineWithHistory(), input = shapes(3); input[2] = shapes(3, 50_000)[2]!;
    const before = bytes(board), clock = board.writerClock(), undo = board.undoManager.undoStack.length;
    expect(capture(board, () => { expect(() => planImport(board, input, options(board, { maxUpdateBytes: 4_000 }))).toThrow('position 3'); })).toEqual([]);
    expect(bytes(board)).toEqual(before); expect(board.writerClock()).toBe(clock); expect(board.undoManager.undoStack).toHaveLength(undo); board.destroy();
  });
  it('uses the shared decoded-resource walk even for a single update below the byte cap', () => {
    const board = new BoardDocument(), points = Array.from({ length: 70_000 }, (_, i) => [i % 100, i % 90, .5]).flat();
    const element = createElement('stroke', { id: 'huge-points', props: { points, simplified: false } });
    const clone = new BoardDocument(); const emitted = capture(clone, () => clone.add(element));
    expect(emitted[0]!.length).toBeLessThan(4 * MB); expect(() => checkUpdateResources(emitted[0]!, board.doc)).toThrow('too many');
    const before = bytes(board); expect(() => planImport(board, [element], options(board))).toThrow('too many'); expect(bytes(board)).toEqual(before);
    clone.destroy(); board.destroy();
  });
  it('checks logical growth against the pre-candidate baseline, splitting or rejecting configured limits', () => {
    const board = new BoardDocument();
    const plan = planImport(board, shapes(3), options(board, { maxClockGrowth: 2 }));
    expect(plan.batches).toHaveLength(3); expect(plan.batches.every(batch => batch.elements.length === 1)).toBe(true);
    expect(() => planImport(board, shapes(1), options(board, { maxClockGrowth: 1 }))).toThrow('logical clock growth'); board.destroy();
  });
  it('counts full multibyte framing, inbound reserve and exact accepted storage bytes', () => {
    const board = new BoardDocument(), input = shapes(1), initial = options(board), plan = planImport(board, input, initial), batch = plan.batches[0]!;
    expect(batch.frameBytes).toBe(syncFrameBytes(initial.documentName, batch.payloadBytes)); expect(batch.frameBytes).toBeGreaterThan(batch.payloadBytes);
    expect(() => planImport(board, input, options(board, { maxUpdateBytes: batch.payloadBytes }))).toThrow('frame');
    expect(() => planImport(board, input, { ...initial, budget: budget(board, { maxInboundBytes: batch.frameBytes }), inboundReserveBytes: 1 })).toThrow('frame');
    const capacity = initial.budget.snapshotBytes + batch.acceptedBytes;
    expect(planImport(board, input, options(board, { maxBoardBytes: capacity })).storageBytesAfter).toBe(capacity);
    expect(() => planImport(board, input, options(board, { maxBoardBytes: capacity - 1 }))).toThrow('storage');
    const server = new Y.Doc(); Y.applyUpdate(server, bytes(board)); const validator = new BoardUpdateValidator(server);
    expect(validator.validate(batch.update).length).toBe(batch.acceptedBytes); validator.dispose(); server.destroy(); board.destroy();
  });
  it('accepts exact single-element frame and inbound-reserve limits and rejects either one byte below', () => {
    const board = new BoardDocument(), input = shapes(1), base = options(board), batch = planImport(board, input, base).batches[0]!;
    const cap = Math.max(batch.frameBytes, batch.reconnectFrameBytes), reserve = 23;
    const atLimit = { ...base, budget: budget(board, { maxUpdateBytes: cap, maxInboundBytes: cap + reserve }), inboundReserveBytes: reserve };
    const plan = planImport(board, input, atLimit);
    expect(plan.batches).toHaveLength(1); expect(plan.batches[0]!.elements).toHaveLength(1);
    expect(Math.max(plan.batches[0]!.frameBytes, plan.batches[0]!.reconnectFrameBytes)).toBe(cap);
    expect(() => planImport(board, input, { ...atLimit, budget: { ...atLimit.budget, maxUpdateBytes: cap - 1 } })).toThrow('frame limit');
    expect(() => planImport(board, input, { ...atLimit, budget: { ...atLimit.budget, maxInboundBytes: cap + reserve - 1 } })).toThrow('frame limit');
    expect(board.readAll()).toEqual([]); expect(board.undoManager.undoStack).toHaveLength(0); board.destroy();
  });
  it('requires acknowledged baseline history and includes historical deletion bytes in reconnect bounds', () => {
    const board = baselineWithHistory(), input = shapes(1), plan = planImport(board, input, options(board));
    expect(plan.batches[0]!.reconnectPayloadBytes).toBeGreaterThan(plan.batches[0]!.payloadBytes);
    expect(() => planImport(board, input, options(board, { stateVector: new Uint8Array([0]) }))).toThrow('acknowledgement');
    const cap = plan.batches[0]!.frameBytes;
    expect(() => planImport(board, input, options(board, { maxUpdateBytes: cap }))).toThrow('reconnect history'); board.destroy();
  });
  it('advances assumed acknowledged vectors across batches rather than aggregating all unsent changes', () => {
    const board = new BoardDocument(), plan = planImport(board, shapes(30, 1_000), options(board, { maxUpdateBytes: 4_000 }));
    expect(plan.batches.length).toBeGreaterThan(5);
    expect(plan.batches.every(batch => batch.reconnectFrameBytes <= 4_000)).toBe(true);
    const total = plan.batches.reduce((sum, batch) => sum + batch.payloadBytes, 0); expect(total).toBeGreaterThan(4_000);
    board.destroy();
  });
  it('sums exact accepted append bytes rather than estimating a compacted snapshot', () => {
    const board = baselineWithHistory(), plan = planImport(board, shapes(20, 1_000), options(board, { maxUpdateBytes: 4_000, updateBytes: 900 }));
    expect(plan.totalAcceptedBytes).toBe(plan.batches.reduce((sum, batch) => sum + batch.acceptedBytes, 0));
    expect(plan.storageBytesAfter).toBe(bytes(board).length + 900 + plan.totalAcceptedBytes); board.destroy();
  });
});
