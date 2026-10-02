import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { BoardDocument, WRITER_PREFIX } from '../src/document.js';
import { createElement } from '../src/schema.js';
import { assertValidBoardDocument, inspectBoardDocument } from '../src/document-validation.js';

function poison(board: BoardDocument, records: unknown[]): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(board.doc));
  peer.getArray(WRITER_PREFIX + 'hostile').push(records);
  try { Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(peer), 'network'); }
  finally { peer.destroy(); }
}
function base(id: string, element: unknown) {
  return { key: JSON.stringify([id, '$base']), val: { stamp: { clock: 1, actor: 'hostile' }, value: { generation: 'hostile:0', element } } };
}

describe('hostile writer records', () => {
  it('quarantines malformed elements in a remote observer and still permits deletion and reorder', () => {
    const board = new BoardDocument();
    try {
      board.create('rect', { id: 'good' });
      board.subscribe(({ ids }) => { for (const id of ids) board.read(id); });
      expect(() => poison(board, [base('bad', { ...createElement('rect', { id: 'bad' }), x: 'nope' })])).not.toThrow();
      expect(board.readAll().map(element => element.id)).toEqual(['good']);
      expect(() => board.reorder('good', 'front')).not.toThrow();
      expect(() => board.delete('bad')).not.toThrow();
      expect(board.read('bad')).toBeUndefined();
    } finally { board.destroy(); }
  });

  it.each([
    null,
    7,
    { key: 'not JSON', val: { stamp: { clock: 100, actor: 'hostile' }, value: null } },
    { key: JSON.stringify(['bad', '$base']), val: { value: null } },
    { key: JSON.stringify(['bad', '$base']), val: { stamp: { clock: Infinity, actor: 'hostile' }, value: null } },
  ])('ignores malformed raw record %j without crashing apply or future writes', record => {
    const board = new BoardDocument();
    try {
      board.create('rect', { id: 'good' });
      expect(() => poison(board, [record])).not.toThrow();
      expect(board.readAll().map(element => element.id)).toEqual(['good']);
      expect(() => board.create('ellipse', { id: 'next' })).not.toThrow();
    } finally { board.destroy(); }
  });

  it('keeps projected reads available after foreign metadata while refusing writes', () => {
    const board = new BoardDocument();
    try {
      board.create('rect', { id: 'good' });
      board.doc.getMap('meta').set('schemaVersion', 99);
      expect(board.readAll().map(element => element.id)).toEqual(['good']);
      expect(() => board.create('ellipse')).toThrow('Unsupported board schema');
    } finally { board.destroy(); }
  });
});

describe('raw document validation', () => {
  it('does not mutate registers or emit updates when inspecting duplicate records', () => {
    const doc = new Y.Doc();
    doc.getMap('meta').set('schemaVersion', 2);
    const record = base('good', createElement('rect', { id: 'good' }));
    doc.getArray(WRITER_PREFIX + 'hostile').push([record, record]);
    const before = Y.encodeStateAsUpdate(doc); let updates = 0;
    doc.on('update', () => updates++);
    expect(inspectBoardDocument(doc).elements.map(element => element.id)).toEqual(['good']);
    expect(() => assertValidBoardDocument(doc)).not.toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before); expect(updates).toBe(0);
    doc.destroy();
  });

  it('rejects new poison while allowing an unrelated edit and repair of historical poison', () => {
    const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2);
    const records = doc.getArray(WRITER_PREFIX + 'hostile');
    records.push([base('bad', { ...createElement('rect', { id: 'bad' }), x: 'poison' })]);
    const old = inspectBoardDocument(doc);
    expect(old.invalidIds.has('bad')).toBe(true);
    expect(() => assertValidBoardDocument(doc)).toThrow('Invalid whiteboard document');
    records.push([base('good', createElement('rect', { id: 'good' }))]);
    expect(() => assertValidBoardDocument(doc, old)).not.toThrow();
    records.delete(0);
    records.push([{ key: JSON.stringify(['bad', '$base']), val: { stamp: { clock: 2, actor: 'hostile' }, value: null } }]);
    expect(() => assertValidBoardDocument(doc, old)).not.toThrow();
    records.push([{ key: JSON.stringify(['good', 'hostile:0', 'x']), val: { stamp: { clock: 3, actor: 'hostile' }, value: 'poison' } }]);
    expect(() => assertValidBoardDocument(doc, old)).toThrow('element-projection');
    doc.destroy();
  });

  it('does not mistake a changed invalid same-key record for historical poison', () => {
    const doc = new Y.Doc(), records = doc.getArray(WRITER_PREFIX + 'hostile');
    records.push([{ key: 'bad key', val: 'old poison' }]);
    const old = inspectBoardDocument(doc); records.delete(0); records.push([{ key: 'bad key', val: 'new poison' }]);
    expect(() => assertValidBoardDocument(doc, old)).toThrow('writer-record');
    doc.destroy();
  });

  it('rejects foreign metadata and invalid inactive base records', () => {
    const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 99);
    expect(() => assertValidBoardDocument(doc)).toThrow('schema-version');
    doc.getMap('meta').set('schemaVersion', 2);
    doc.getArray(WRITER_PREFIX + 'hostile').push([
      base('bad', { ...createElement('rect', { id: 'different' }) }),
      { key: JSON.stringify(['bad', '$base']), val: { stamp: { clock: 2, actor: 'hostile' }, value: null } },
    ]);
    expect(() => assertValidBoardDocument(doc)).toThrow('element-base');
    doc.destroy();
  });

  it('emits diagnostics for raw junk and metadata even when no element ids change', () => {
    const board = new BoardDocument(), changes: { count: number; version: unknown; ids: number }[] = [];
    board.subscribe(change => changes.push({ count: change.malformedRecords, version: change.schemaVersion, ids: change.ids.size }));
    poison(board, [null]);
    expect(board.malformedRecords).toBe(1); expect(changes.at(-1)).toEqual({ count: 1, version: 2, ids: 0 });
    board.meta.set('schemaVersion', 99);
    expect(changes.at(-1)).toEqual({ count: 1, version: 99, ids: 0 });
    board.destroy();
  });

  it('quarantines falsy bases instead of silently treating them as deleted', () => {
    const board = new BoardDocument();
    poison(board, [{ key: JSON.stringify(['bad', '$base']), val: { stamp: { clock: 1, actor: 'hostile' }, value: false } }]);
    expect(board.readAll()).toEqual([]); expect(board.invalidIds.has('bad')).toBe(true);
    board.delete('bad'); expect(board.invalidIds.has('bad')).toBe(false);
    board.destroy();
  });

  it('rejects wrong root types even after raw network types are materialized on a clone', () => {
    const doc = new Y.Doc(); doc.getArray('meta').push(['wrong root']);
    doc.getMap(WRITER_PREFIX + 'hostile').set('not-an-array', 'bad');
    const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateAsUpdate(copy); let updates = 0;
    copy.on('update', () => updates++);
    const inspection = inspectBoardDocument(copy);
    expect(inspection.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['metadata-root', 'writer-root']));
    expect(() => assertValidBoardDocument(copy)).toThrow();
    expect(Y.encodeStateAsUpdate(copy)).toEqual(before); expect(updates).toBe(0);
    doc.destroy(); copy.destroy();
  });

  it('quarantines exhausted hostile clocks without disabling healthy create, update or delete', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'good' });
    const exhausted = base('bad', createElement('rect', { id: 'bad' })); exhausted.val.stamp.clock = Number.MAX_SAFE_INTEGER;
    poison(board, [exhausted]);
    expect(board.malformedRecords).toBe(1); expect(board.read('bad')).toBeUndefined();
    board.create('ellipse', { id: 'next' }); board.update('good', { x: 75 }); board.delete('next');
    expect(board.read('good')!.x).toBe(75); expect(board.read('next')).toBeUndefined();
    expect(() => assertValidBoardDocument(board.doc)).toThrow('writer-record');
    const reloadedDoc = new Y.Doc(); Y.applyUpdate(reloadedDoc, Y.encodeStateAsUpdate(board.doc));
    const reloaded = new BoardDocument(reloadedDoc); reloaded.update('good', { x: 90 });
    expect(reloaded.read('good')!.x).toBe(90);
    board.destroy(); reloaded.destroy();
  });
});
