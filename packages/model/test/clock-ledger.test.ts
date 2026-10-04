import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { BoardDocument, CLOCK_KEY } from '../src/document.js';
import { assertValidBoardDocument, BoardUpdateValidator, inspectBoardDocument } from '../src/document-validation.js';

const NETWORK = Symbol('network');
const clockRoot = (actor: string) => `clock:${actor}`;
function copy(doc: Y.Doc): Y.Doc { const result = new Y.Doc(); Y.applyUpdate(result, Y.encodeStateAsUpdate(doc), NETWORK); return result; }
function fullAccepts(live: Y.Doc, update: Uint8Array): boolean {
  const candidate = copy(live), before = inspectBoardDocument(candidate);
  try { Y.applyUpdate(candidate, update); assertValidBoardDocument(candidate, before); return true; }
  catch { return false; }
  finally { candidate.destroy(); }
}

describe('writer clock roots outside undo history', () => {
  it('emits one undo and redo packet without cleanup packets from three connected peers', () => {
    const seed = new BoardDocument(); seed.create('rect', { id: 'shape' });
    const boards = [1, 2, 3].map(clientID => { const doc = copy(seed.doc); doc.clientID = clientID; return new BoardDocument(doc); });
    seed.destroy();
    const packets: { from: number; update: Uint8Array }[] = [], emitted = [0, 0, 0];
    boards.forEach((board, from) => board.doc.on('update', (update, origin) => {
      if (origin !== NETWORK) { emitted[from]!++; packets.push({ from, update }); }
    }));
    const flush = () => {
      let rounds = 0;
      while (packets.length) {
        expect(++rounds).toBeLessThan(20);
        for (const { from, update } of packets.splice(0)) for (const [to, board] of boards.entries()) if (to !== from) Y.applyUpdate(board.doc, update, NETWORK);
      }
      for (const board of boards) expect(board.readAll()).toEqual(boards[0]!.readAll());
    };
    try {
      const author = boards[0]!;
      // Undoing the first gesture cannot expose an earlier own clock. The
      // second gesture is the regression trigger for peer-side cleanup writes.
      author.move(['shape'], { x: 10, y: 20 }); flush();
      author.move(['shape'], { x: 10, y: 20 }); flush();
      expect(author.undoManager.undoStack).toHaveLength(2);
      emitted.fill(0); author.undoManager.undo(); flush();
      expect(emitted).toEqual([1, 0, 0]);
      expect(author.read('shape')).toMatchObject({ x: 10, y: 20 });
      emitted.fill(0); author.undoManager.redo(); flush();
      expect(emitted).toEqual([1, 0, 0]);
      boards[1]!.updateStyle(['shape'], { fill: '#123456' }); flush();
      author.undoManager.undo(); flush();
      expect(author.read('shape')).toMatchObject({ x: 10, y: 20, style: { fill: '#123456' } });
    } finally { boards.forEach(board => board.destroy()); }
  });

  it('writes the clock in the gesture transaction and keeps it unchanged through undo and redo', () => {
    const board = new BoardDocument(), updates: Uint8Array[] = [];
    board.doc.on('update', value => updates.push(value));
    try {
      board.create('rect', { id: 'shape' });
      expect(updates).toHaveLength(1);
      const ledger = board.doc.getMap(clockRoot(board.actor)), clock = ledger.get('value');
      expect(clock).toBeGreaterThan(0);
      expect(board.own.kv.get(CLOCK_KEY)).toBeUndefined();
      board.move(['shape'], { x: 15, y: 25 });
      const movedClock = ledger.get('value'); expect(movedClock).toBeGreaterThan(clock as number);
      board.undoManager.undo(); expect(ledger.get('value')).toBe(movedClock);
      board.undoManager.redo(); expect(ledger.get('value')).toBe(movedClock);
    } finally { board.destroy(); }
  });

  it.each([
    ['negative', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('value', -1); }],
    ['fractional', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('value', .5); }],
    ['unsafe', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('value', Number.MAX_SAFE_INTEGER + 1); }],
    ['impossible', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('value', Number.MAX_SAFE_INTEGER); }],
    ['wrong value', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('value', '1'); }],
    ['extra field', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('extra', 1); }],
    ['nested type', (doc: Y.Doc): void => { doc.getMap(clockRoot('bad')).set('value', new Y.Map()); }],
    ['array root', (doc: Y.Doc): void => { doc.getArray(clockRoot('bad')).push([1]); }],
    ['empty actor', (doc: Y.Doc): void => { doc.getMap(clockRoot('')).set('value', 1); }],
  ] as const)('rejects %s clock roots in full and cached preflight without mutating live state', (_name, mutate) => {
    const live = new Y.Doc(); live.getMap('meta').set('schemaVersion', 2);
    const validator = new BoardUpdateValidator(live), peer = copy(live), before = Y.encodeStateAsUpdate(live);
    try {
      mutate(peer); const update = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
      expect(fullAccepts(live, update)).toBe(false);
      expect(() => validator.validate(update)).toThrow(/clock/);
      expect(Y.encodeStateAsUpdate(live)).toEqual(before);
      const healthy = copy(live);
      try {
        healthy.getMap(clockRoot('healthy')).set('value', 1);
        expect(() => validator.validate(Y.encodeStateAsUpdate(healthy, Y.encodeStateVector(live)))).not.toThrow();
      } finally { healthy.destroy(); }
    } finally { validator.dispose(); live.destroy(); peer.destroy(); }
  });

  it('allows an unchanged bad historical root and its repair but rejects changed poison', () => {
    const live = new Y.Doc(); live.getMap(clockRoot('bad')).set('value', -1);
    const validator = new BoardUpdateValidator(live);
    try {
      const peer = copy(live); peer.getMap('meta').set('schemaVersion', 2);
      expect(() => validator.validate(Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live)))).not.toThrow(); peer.destroy();
      const changed = copy(live); changed.getMap(clockRoot('bad')).set('value', -2);
      expect(() => validator.validate(Y.encodeStateAsUpdate(changed, Y.encodeStateVector(live)))).toThrow(/clock/); changed.destroy();
      const repaired = copy(live); repaired.getMap(clockRoot('bad')).set('value', 1);
      expect(() => validator.validate(Y.encodeStateAsUpdate(repaired, Y.encodeStateVector(live)))).not.toThrow(); repaired.destroy();
    } finally { validator.dispose(); live.destroy(); }
  });

  it('rechecks an impossible historical root when its causal dependencies make the clock eligible', () => {
    const live = new Y.Doc(); live.getMap('meta').set('schemaVersion', 2);
    live.getMap(clockRoot('future')).set('value', 8);
    const validator = new BoardUpdateValidator(live), peer = copy(live);
    try {
      expect(inspectBoardDocument(live).issues).toHaveLength(1);
      peer.getArray('history').push(Array.from({ length: 10 }, () => 'causal history'));
      const update = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
      expect(fullAccepts(live, update)).toBe(true);
      const accepted = validator.validate(update); Y.applyUpdate(live, accepted); validator.syncLive(accepted);
      expect(inspectBoardDocument(live).issues).toHaveLength(0);
      peer.getMap(clockRoot('future')).set('value', Number.MAX_SAFE_INTEGER);
      expect(() => validator.validate(Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live)))).toThrow(/clock/);
    } finally { validator.dispose(); live.destroy(); peer.destroy(); }
  });

  it('detects nested mutations of historically invalid clock roots', () => {
    const live = new Y.Doc(), nested = new Y.Map();
    live.getMap(clockRoot('bad')).set('value', nested);
    const validator = new BoardUpdateValidator(live), peer = copy(live);
    try {
      (peer.getMap(clockRoot('bad')).get('value') as Y.Map<unknown>).set('changed', 1);
      const update = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
      expect(fullAccepts(live, update)).toBe(false);
      expect(() => validator.validate(update)).toThrow(/clock/);
    } finally { validator.dispose(); live.destroy(); peer.destroy(); }
  });

  it('quarantines an impossible clock without disabling edits, including after reload', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'shape' });
    const attacker = copy(board.doc); attacker.getMap(clockRoot('bad')).set('value', Number.MAX_SAFE_INTEGER);
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(attacker), NETWORK); attacker.destroy();
    try {
      expect(board.malformedRecords).toBe(1);
      board.move(['shape'], { x: 10, y: 20 });
      const restored = new BoardDocument(copy(board.doc));
      try { restored.move(['shape'], { x: 10, y: 20 }); expect(restored.read('shape')).toMatchObject({ x: 20, y: 40 }); }
      finally { restored.destroy(); }
    } finally { board.destroy(); }
  });
});
