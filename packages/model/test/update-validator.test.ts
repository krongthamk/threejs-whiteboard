import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { BoardDocument } from '../src/document.js';
import { assertValidBoardDocument, BoardUpdateValidator, causalClockBound, IncompleteBoardUpdateError, inspectBoardDocument, WRITER_PREFIX } from '../src/document-validation.js';
import { createElement } from '../src/schema.js';
import type { Element } from '../src/types.js';

function copy(doc: Y.Doc): Y.Doc { const result = new Y.Doc(); Y.applyUpdate(result, Y.encodeStateAsUpdate(doc)); return result; }
function delta(source: Y.Doc, target: Y.Doc): Uint8Array { return Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)); }
function record(id: string, actor: string, clock: number, element: Element = createElement('rect', { id })) {
  return { key: JSON.stringify([id, '$base']), val: { stamp: { clock, actor }, value: { generation: `${actor}:0`, element } } };
}
function fullAccepts(live: Y.Doc, update: Uint8Array): boolean {
  const candidate = copy(live), before = inspectBoardDocument(candidate);
  try { Y.applyUpdate(candidate, update); assertValidBoardDocument(candidate, before); return true; }
  catch { return false; }
  finally { candidate.destroy(); }
}
function emittedDelta(live: Y.Doc, update: Uint8Array): Uint8Array {
  const receiver = copy(live), emitted: Uint8Array[] = [];
  receiver.on('update', value => emitted.push(value));
  try { Y.applyUpdate(receiver, update); return emitted.length ? Y.mergeUpdates(emitted) : new Uint8Array([0, 0]); }
  finally { receiver.destroy(); }
}

describe('isolated cached board validation', () => {
  it('returns only the emitted delta for offline packets containing already applied deletion history', () => {
    const history = new Y.Doc(); history.getArray('history').push(Array.from({ length: 40 }, () => 'value'));
    for (let index = 38; index >= 0; index -= 2) history.getArray('history').delete(index, 1);
    const live = copy(history), offline = copy(live), validator = new BoardUpdateValidator(live);
    offline.getArray('history').push(['new']);
    const incoming = delta(offline, live), expected = emittedDelta(live, incoming), before = Y.encodeStateAsUpdate(live);
    let persistedBytes = 0; live.on('update', update => { persistedBytes += update.byteLength; });
    expect(incoming.byteLength).toBeGreaterThan(expected.byteLength);
    const accepted = validator.validate(incoming);
    expect(accepted).toEqual(expected);
    expect(Y.encodeStateAsUpdate(live)).toEqual(before);
    expect(persistedBytes).toBe(0);
    // Replays have no incremental storage charge, even though their wire packet retains old deletes.
    expect(validator.validate(incoming)).toEqual(new Uint8Array([0, 0]));
    Y.applyUpdate(live, accepted); validator.syncLive(accepted);
    expect(persistedBytes).toBe(expected.byteLength);
    expect(live.getArray('history').toArray()).toEqual(offline.getArray('history').toArray());
    persistedBytes = 0;
    const replay = validator.validate(delta(offline, live));
    expect(replay).toEqual(new Uint8Array([0, 0]));
    Y.applyUpdate(live, replay); validator.syncLive(replay);
    expect(persistedBytes).toBe(0);
    validator.dispose(); [history, live, offline].forEach(doc => doc.destroy());
  });

  it('never mutates the live document and accepts replay and a new offline writer', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'good' });
    const offline = new BoardDocument(copy(board.doc)); offline.create('ellipse', { id: 'offline' });
    const validator = new BoardUpdateValidator(board.doc), update = delta(offline.doc, board.doc), before = Y.encodeStateAsUpdate(board.doc);
    let updates = 0; board.doc.on('update', () => updates++);
    validator.validate(update); validator.validate(update);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(updates).toBe(0);
    expect(validator.getStats().cachedElements).toBe(2);
    Y.applyUpdate(board.doc, update); validator.syncLive(update);
    expect(board.readAll().map(element => element.id)).toEqual(['good', 'offline']);
    validator.dispose(); expect(validator.getStats().cachedRecords).toBe(0);
    expect(() => validator.validate(update)).toThrow('disposed');
    board.destroy(); offline.destroy();
  });

  it('matches full validation for new nonwinning poison, metadata, raw junk, and repair', () => {
    const live = new Y.Doc(); live.getMap('meta').set('schemaVersion', 2);
    live.getArray(WRITER_PREFIX + 'legacy').push([record('bad', 'legacy', 1, { ...createElement('rect', { id: 'bad' }), x: 'bad' } as never)]);
    const validator = new BoardUpdateValidator(live);
    const check = (mutate: (doc: Y.Doc) => void, expected: boolean) => {
      const peer = copy(live); mutate(peer); const update = delta(peer, live);
      expect(fullAccepts(live, update)).toBe(expected);
      if (expected) { expect(() => validator.validate(update)).not.toThrow(); Y.applyUpdate(live, update); validator.syncLive(update); }
      else expect(() => validator.validate(update)).toThrow();
      peer.destroy();
    };
    check(doc => doc.getArray(WRITER_PREFIX + 'new').push([record('healthy', 'new', 1)]), true);
    check(doc => doc.getArray(WRITER_PREFIX + 'legacy').push([{ key: 'not-json', val: null }]), false);
    check(doc => doc.getMap('meta').set('schemaVersion', 99), false);
    // Poison is followed by a higher-clock tombstone; it must still be checked as a raw record.
    check(doc => doc.getArray(WRITER_PREFIX + 'hidden').push([
      record('hidden', 'hidden', 1, { ...createElement('rect', { id: 'hidden' }), x: 'bad' } as never),
      { key: JSON.stringify(['hidden', '$base']), val: { stamp: { clock: 2, actor: 'hidden' }, value: null } },
    ]), false);
    check(doc => doc.getArray(WRITER_PREFIX + 'legacy').delete(0), true);
    check(doc => doc.getArray(WRITER_PREFIX + 'legacy').push([record('repaired', 'legacy', 2)]), true);
    validator.dispose(); live.destroy();
  });

  it('rebuilds after rejection and accepts a healthy update without ghost winners', () => {
    const live = new Y.Doc(); live.getMap('meta').set('schemaVersion', 2);
    const validator = new BoardUpdateValidator(live), attacker = copy(live);
    attacker.getArray(WRITER_PREFIX + 'new').push([null]);
    expect(() => validator.validate(delta(attacker, live))).toThrow('writer-record');
    expect(validator.getStats().fullScans).toBe(2);
    const healthy = copy(live); healthy.getArray(WRITER_PREFIX + 'new').push([record('healthy', 'new', 1)]);
    validator.validate(delta(healthy, live)); expect(validator.getStats().cachedElements).toBe(1);
    validator.dispose(); [live, attacker, healthy].forEach(doc => doc.destroy());
  });

  it('matches full validation for delete sets, duplicate delivery and undo history', () => {
    const author = new BoardDocument(); author.create('rect', { id: 'same' });
    const live = copy(author.doc), validator = new BoardUpdateValidator(live);
    for (const change of [() => author.update('same', { x: 90 }), () => author.delete('same'), () => author.undoManager.undo(), () => author.undoManager.redo()]) {
      change(); const update = delta(author.doc, live);
      expect(fullAccepts(live, update)).toBe(true); expect(validator.validate(update)).toEqual(emittedDelta(live, update));
      Y.applyUpdate(live, update); validator.syncLive(update); validator.validate(update);
      expect(validator.getStats().cachedElements).toBe(inspectBoardDocument(live).elements.length);
    }
    validator.dispose(); live.destroy(); author.destroy();
  });

  it('rejects a malicious missing-prefix suffix without poisoning a later healthy prefix', () => {
    const live = new Y.Doc(), source = new Y.Doc(); live.getMap('meta').set('schemaVersion', 2);
    const array = source.getArray(WRITER_PREFIX + 'offline'), prefix = record('prefix', 'offline', 1);
    array.push([prefix]); const prefixUpdate = Y.encodeStateAsUpdate(source), afterPrefix = Y.encodeStateVector(source);
    array.push([record('poison', 'offline', 2, { ...createElement('rect', { id: 'poison' }), x: 'bad' } as never)]);
    const suffix = Y.encodeStateAsUpdate(source, afterPrefix), validator = new BoardUpdateValidator(live), before = Y.encodeStateAsUpdate(live);
    expect(() => validator.validate(suffix)).toThrow(IncompleteBoardUpdateError);
    expect(Y.encodeStateAsUpdate(live)).toEqual(before); expect(live.store.pendingStructs).toBeNull();
    validator.validate(prefixUpdate); Y.applyUpdate(live, prefixUpdate); validator.syncLive(prefixUpdate);
    expect(() => validator.validate(suffix)).toThrow('element-base');
    const healthy = copy(live); healthy.getArray(WRITER_PREFIX + 'healthy').push([record('next', 'healthy', 1)]);
    validator.validate(delta(healthy, live));
    validator.dispose(); [live, source, healthy].forEach(doc => doc.destroy());
  });

  it('retries honest out-of-order suffixes and pending delete sets with complete state', () => {
    const live = new Y.Doc(), source = new Y.Doc(), array = source.getArray(WRITER_PREFIX + 'offline');
    array.push([record('first', 'offline', 1)]); const prefix = Y.encodeStateAsUpdate(source), state = Y.encodeStateVector(source);
    array.push([record('second', 'offline', 2)]); const suffix = Y.encodeStateAsUpdate(source, state);
    const validator = new BoardUpdateValidator(live);
    expect(() => validator.validate(suffix)).toThrow(IncompleteBoardUpdateError);
    validator.validate(prefix); Y.applyUpdate(live, prefix); validator.syncLive(prefix);
    validator.validate(suffix); Y.applyUpdate(live, suffix); validator.syncLive(suffix);
    expect(inspectBoardDocument(live).elements).toEqual(inspectBoardDocument(source).elements);
    const deletionSource = new Y.Doc(); deletionSource.getArray('unrelated').push(['remove']); const beforeDelete = Y.encodeStateVector(deletionSource);
    deletionSource.getArray('unrelated').delete(0); const deleteOnly = Y.encodeStateAsUpdate(deletionSource, beforeDelete);
    expect(() => validator.validate(deleteOnly)).toThrow(IncompleteBoardUpdateError);
    const complete = Y.encodeStateAsUpdate(deletionSource); validator.validate(complete); Y.applyUpdate(live, complete); validator.syncLive(complete);
    expect(live.store.pendingDs).toBeNull();
    validator.dispose(); [live, source, deletionSource].forEach(doc => doc.destroy());
  });

  it('tracks trusted live legacy additions then rejects changed poison fingerprints', () => {
    const live = new Y.Doc(), validator = new BoardUpdateValidator(live);
    live.getArray(WRITER_PREFIX + 'old').push([{ key: 'bad', val: 'legacy' }]); validator.syncLive();
    const changed = copy(live); changed.getArray(WRITER_PREFIX + 'old').delete(0); changed.getArray(WRITER_PREFIX + 'old').push([{ key: 'bad', val: 'changed' }]);
    expect(fullAccepts(live, delta(changed, live))).toBe(false); expect(() => validator.validate(delta(changed, live))).toThrow('writer-record');
    validator.dispose(); live.destroy(); changed.destroy();
  });

  it('checks nested mutation of historical malformed raw records', () => {
    const live = new Y.Doc(), nested = new Y.Map(); nested.set('initial', 'junk');
    live.getArray(WRITER_PREFIX + 'legacy').push([nested]); const validator = new BoardUpdateValidator(live), peer = copy(live);
    (peer.getArray(WRITER_PREFIX + 'legacy').get(0) as Y.Map<unknown>).set('changed', 'junk');
    expect(fullAccepts(live, delta(peer, live))).toBe(false); expect(() => validator.validate(delta(peer, live))).toThrow('writer-record');
    validator.dispose(); live.destroy(); peer.destroy();
  });

  it('matches full validation for wrong metadata and writer roots, including changed historical root values', () => {
    const live = new Y.Doc(), validator = new BoardUpdateValidator(live);
    const wrongMeta = new Y.Doc(); wrongMeta.getArray('meta').push(['not a map']);
    const wrongWriter = new Y.Doc(); wrongWriter.getMap(WRITER_PREFIX + 'wrong').set('key', 'not an array');
    for (const peer of [wrongMeta, wrongWriter]) {
      const update = delta(peer, live);
      expect(fullAccepts(live, update)).toBe(false); expect(() => validator.validate(update)).toThrow();
    }
    Y.applyUpdate(live, Y.encodeStateAsUpdate(wrongWriter)); validator.syncLive();
    wrongWriter.getMap(WRITER_PREFIX + 'wrong').set('key', 'changed');
    const changed = delta(wrongWriter, live);
    expect(fullAccepts(live, changed)).toBe(false); expect(() => validator.validate(changed)).toThrow('writer-root');
    validator.dispose(); [live, wrongMeta, wrongWriter].forEach(doc => doc.destroy());
  });

  it('rechecks a historically impossible clock when added causal history makes it eligible', () => {
    const live = new Y.Doc();
    live.getArray(WRITER_PREFIX + 'legacy').push([record('hidden', 'legacy', 8, { ...createElement('rect', { id: 'hidden' }), x: 'bad' } as never)]);
    const validator = new BoardUpdateValidator(live), peer = copy(live);
    peer.getArray('unrelated').push(Array.from({ length: 8 }, (_, i) => i));
    const update = delta(peer, live);
    expect(fullAccepts(live, update)).toBe(false); expect(() => validator.validate(update)).toThrow('element-base');
    validator.dispose(); live.destroy(); peer.destroy();
  });

  it('supports full offline state retry after a rejected incomplete packet', () => {
    const live = new Y.Doc(), source = new Y.Doc(), records = source.getArray(WRITER_PREFIX + 'offline');
    records.push([record('first', 'offline', 1)]); const prefixVector = Y.encodeStateVector(source);
    records.push([record('second', 'offline', 2)]);
    const validator = new BoardUpdateValidator(live);
    expect(() => validator.validate(Y.encodeStateAsUpdate(source, prefixVector))).toThrow(IncompleteBoardUpdateError);
    const full = Y.encodeStateAsUpdate(source); validator.validate(full); Y.applyUpdate(live, full); validator.syncLive(full);
    expect(inspectBoardDocument(live).elements).toEqual(inspectBoardDocument(source).elements);
    validator.dispose(); live.destroy(); source.destroy();
  });

  it('keeps a 5,000-element warm edit bounded to its new record and affected projection', () => {
    const source = new Y.Doc(), actor = String(source.clientID), array = source.getArray(WRITER_PREFIX + actor);
    source.getMap('meta').set('schemaVersion', 2);
    array.push(Array.from({ length: 5000 }, (_, i) => record(`stroke-${i}`, actor, i + 1, createElement('stroke', { id: `stroke-${i}`, props: { points: [i, 0, .5], simplified: false } }))));
    const live = copy(source), validator = new BoardUpdateValidator(live), initial = validator.getStats();
    for (let step = 1; step <= 5; step++) {
      array.push([{ key: JSON.stringify(['stroke-42', `${actor}:0`, 'rotation']), val: { stamp: { clock: 5000 + step, actor }, value: step * .1 } }]);
      const update = delta(source, live); validator.validate(update); Y.applyUpdate(live, update); validator.syncLive(update); validator.validate(update);
      const current = validator.getStats();
      expect(current.fullScans).toBe(1); expect(current.validatedRecords - initial.validatedRecords).toBe(step);
      expect(current.projectedElements - initial.projectedElements).toBe(step); expect(current.cachedElements).toBe(5000);
    }
    array.delete(0, array.length); const deleted = delta(source, live); validator.validate(deleted); Y.applyUpdate(live, deleted); validator.syncLive(deleted);
    expect(validator.getStats().cachedRecords).toBe(0); expect(validator.getStats().cachedElements).toBe(0);
    validator.dispose(); source.destroy(); live.destroy();
  });

  it('matches full validation over seeded offline edits, deletes and recreations', () => {
    const author = new BoardDocument(), live = copy(author.doc), validator = new BoardUpdateValidator(live);
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let step = 0; step < 200; step++) {
      const id = `id-${random() % 12}`, element = author.read(id);
      if (!element) author.create('rect', { id });
      else if (random() % 4 === 0) author.delete(id);
      else author.update(id, { x: random() % 300, y: random() % 200 });
      const update = delta(author.doc, live);
      expect(fullAccepts(live, update)).toBe(true); expect(validator.validate(update)).toEqual(emittedDelta(live, update));
      Y.applyUpdate(live, update); validator.syncLive(update);
      expect(validator.getStats().cachedElements).toBe(inspectBoardDocument(live).elements.length);
    }
    expect(causalClockBound(live)).toBeGreaterThan(200);
    validator.dispose(); live.destroy(); author.destroy();
  });
});
