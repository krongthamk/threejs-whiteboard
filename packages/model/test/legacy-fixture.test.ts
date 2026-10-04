import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { Store, type Role } from '../../server/src/store.js';
import { pruneElement } from '../../server/src/operations.js';
import { BoardDocument, CLOCK_KEY, CLOCK_PREFIX, WRITER_PREFIX, type WriterRecord } from '../src/document.js';
import { assertValidBoardDocument } from '../src/document-validation.js';
import { documentToSvg } from '../src/svg.js';
import type { Element } from '../src/types.js';

const fixtures = fileURLToPath(new URL('../../server/test/fixtures/', import.meta.url));
const provenance = JSON.parse(readFileSync(join(fixtures, 'schema2-pre-f1.provenance.json'), 'utf8')) as {
  artifacts: { path: string; sha256: string }[]; boardId: string; emptyBoardId: string;
  syntheticCredentials: { sessionSecret: string; users: { id: string; role: Role }[] };
  asset: { id: string; storageKey: string; size: number };
  history: { updateLog: { updateCount: number; updateBytes: number; snapshotBytes: number } };
};
const expected = JSON.parse(readFileSync(join(fixtures, 'schema2-pre-f1.expected.json'), 'utf8')) as {
  elements: Element[]; metadata: { title: string; schemaVersion: number };
};
const artifactHashes = () => provenance.artifacts.map(({ path }) => createHash('sha256').update(readFileSync(join(fixtures, path))).digest('hex'));
function withFixture(test: (store: Store) => void): void {
  const before = artifactHashes(), directory = mkdtempSync(join(tmpdir(), 'whiteboard-legacy-clock-'));
  const filename = join(directory, 'whiteboard.sqlite'); copyFileSync(join(fixtures, 'schema2-pre-f1.sqlite'), filename);
  const store = new Store(filename, provenance.syntheticCredentials.sessionSecret);
  try { test(store); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); expect(artifactHashes()).toEqual(before); }
}
function load(store: Store, clientID: number): BoardDocument {
  const doc = new Y.Doc(); Y.applyUpdate(doc, store.loadDocument(provenance.boardId)!); doc.clientID = clientID;
  return new BoardDocument(doc);
}
function writerArrays(board: BoardDocument): { name: string; records: WriterRecord[] }[] {
  return [...board.doc.share.keys()].filter(name => name.startsWith(WRITER_PREFIX) && board.doc.getArray(name).length)
    .sort().map(name => ({ name, records: board.doc.getArray<WriterRecord>(name).toArray() }));
}

describe('immutable pre-feature schema2 clocks', () => {
  it('reopens the real SQLite snapshot/log with identical projection and SVG, then persists new root clocks', () => withFixture(store => {
    expect(artifactHashes()).toEqual(provenance.artifacts.map(artifact => artifact.sha256));
    expect(store.stats(provenance.boardId)).toEqual(provenance.history.updateLog);
    for (const user of provenance.syntheticCredentials.users) expect(store.role(provenance.boardId, user.id)).toBe(user.role);
    expect(store.asset(provenance.boardId, provenance.asset.id)).toMatchObject({ storageKey: provenance.asset.storageKey, size: provenance.asset.size });
    const board = load(store, 303), initialWire = Y.encodeStateAsUpdate(board.doc), legacy = writerArrays(board);
    try {
      expect(board.schemaVersion).toBe(2); expect(board.readAll()).toEqual(expected.elements);
      const png = readFileSync(join(fixtures, provenance.asset.storageKey));
      expect(documentToSvg(board.readAll(), { title: expected.metadata.title, assetUrl: id => id === provenance.asset.id ? `data:image/png;base64,${png.toString('base64')}` : undefined }) + '\n')
        .toBe(readFileSync(join(fixtures, 'schema2-pre-f1.expected.svg'), 'utf8'));
      expect(Y.encodeStateAsUpdate(board.doc)).toEqual(initialWire);
      for (const actor of ['101', '202']) expect(board.writerClock(actor)).toBeGreaterThan(0);
      expect(board.doc.getMap(CLOCK_PREFIX + board.actor).size).toBe(0);
      board.doc.on('update', update => store.appendUpdate(provenance.boardId, update));
      board.move(['legacy-rect'], { x: 7, y: 9 });
      const clock = board.writerClock(); expect(clock).toBeGreaterThan(board.writerClock('101'));
      board.undoManager.undo(); expect(board.readAll()).toEqual(expected.elements); expect(board.writerClock()).toBe(clock);
      board.undoManager.redo(); expect(board.read('legacy-rect')).toMatchObject({ x: 43, y: 39 }); expect(board.writerClock()).toBe(clock);
      // Existing array ledgers and records are not rewritten to migrate them.
      expect(writerArrays(board).filter(writer => writer.name !== WRITER_PREFIX + board.actor)).toEqual(legacy);
      expect(board.own.kv.get(CLOCK_KEY)).toBeUndefined();
      assertValidBoardDocument(board.doc);
      const reopened = load(store, 404);
      try { expect(reopened.readAll()).toEqual(board.readAll()); expect(reopened.writerClock('303')).toBe(clock); assertValidBoardDocument(reopened.doc); }
      finally { reopened.destroy(); }
      const empty = new Y.Doc(); Y.applyUpdate(empty, store.loadDocument(provenance.emptyBoardId)!);
      const emptyBoard = new BoardDocument(empty);
      try { expect(emptyBoard.readAll()).toEqual([]); expect(emptyBoard.schemaVersion).toBe(2); }
      finally { emptyBoard.destroy(); }
    } finally { board.destroy(); }
  }));

  it('prunes with a clock above a retained root maximum after undo', () => withFixture(store => {
    const board = load(store, 303);
    try {
      board.doc.on('update', update => store.appendUpdate(provenance.boardId, update));
      board.move(['legacy-rect'], { x: 1, y: 2 });
      board.move(['legacy-rect'], { x: 3, y: 4 }); board.undoManager.undo();
      const retainedClock = board.writerClock();
      const arrayMaximum = Math.max(...[...board.writers.values()].flatMap(writer => [...writer.kv.map.values()].map(record => record.val.stamp.clock)));
      expect(retainedClock).toBeGreaterThan(arrayMaximum);
      expect(pruneElement(store, provenance.boardId, 'legacy-rect').removedRecords).toBeGreaterThan(0);
      const reopened = load(store, 404);
      try {
        expect(reopened.read('legacy-rect')).toBeUndefined();
        const tombstones = [...reopened.writers.values()].flatMap(writer => writer.records.toArray()).filter((record: WriterRecord) => record.key === JSON.stringify(['legacy-rect', '$base']) && record.val.value === null);
        expect(tombstones).toHaveLength(1);
        const repair = tombstones[0]!;
        expect(repair.val.stamp.clock).toBe(retainedClock + 1);
        expect(reopened.doc.getMap(CLOCK_PREFIX + repair.val.stamp.actor).get('value')).toBe(repair.val.stamp.clock);
        expect(reopened.writerClock('101')).toBeGreaterThan(0); assertValidBoardDocument(reopened.doc);
      } finally { reopened.destroy(); }
    } finally { board.destroy(); }
  }));
});
