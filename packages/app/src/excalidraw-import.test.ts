import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardDocument, bindToElement, createElement, importExcalidraw, MAX_EXCALIDRAW_BYTES, type ImportBudget } from '@whiteboard/model';
import { ExcalidrawImporter, isExcalidrawText, parseExcalidrawSource, placeImportedElements, type ImportReport } from './excalidraw-import';
import { createSession } from './session';
import type { ImportLease } from './import-transport';
import { pngHeader } from '../../../tests/image-fixtures';
import { api } from './api';
vi.mock('@whiteboard/renderer', async () => await import('../../renderer/src/abort'));
let board: BoardDocument, session: ReturnType<typeof createSession>, importer: ExcalidrawImporter;
beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }); board = new BoardDocument(); session = createSession('imports'); });
afterEach(() => { importer?.destroy(); session.dispose(); board.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = (count = 1) => JSON.stringify({ type: 'excalidraw', version: 2, elements: Array.from({ length: count }, (_, i) => ({ id: 'source-' + i, type: 'rectangle', x: 100 + i * 5, y: 100, width: 100, height: 80 })) });
const imageSource = (bytes = pngHeader(10, 10), mimeType = 'image/png') => ({ type: 'excalidraw', version: 2,
  elements: [{ id: 'image', type: 'image', fileId: 'pixels', x: 0, y: 0, width: 10, height: 10 }],
  files: { pixels: { mimeType, dataURL: `data:${mimeType};base64,` + Buffer.from(bytes).toString('base64') } } });
function fixture(options: { limit?: number; imageLimit?: number; readOnly?: () => boolean; acknowledgment?: () => Promise<void>; budget?: () => Promise<ImportBudget> } = {}) {
  const reports: ImportReport[] = [], release = vi.fn(), controller = new AbortController();
  const budget = options.budget ?? (async () => ({ maxUpdateBytes: options.limit ?? 4e6, maxBoardBytes: 64e6, maxInboundBytes: 8e6, maxClockGrowth: 1e6, snapshotBytes: 0, updateBytes: 0, stateVector: Y.encodeStateVector(board.doc) }));
  const lease: ImportLease = { signal: controller.signal, assertReady: () => controller.signal.throwIfAborted(), budget, waitAcknowledged: options.acknowledgment ?? (async () => {}), release };
  importer = new ExcalidrawImporter({ board, boardId: 'imports', session, canvas: { getBoundingClientRect: () => ({ width: 1000, height: 800 }) } as unknown as HTMLCanvasElement,
    transport: { beginImport: signal => { signal.addEventListener('abort', () => controller.abort(signal.reason)); return lease; } }, isReadOnly: options.readOnly ?? (() => false), maxImageDimension: () => options.imageLimit ?? 4096, onReport: r => reports.push(structuredClone(r)) });
  return { reports, release, controller };
}
it('recognizes clipboard envelopes before the smaller whiteboard clipboard cap and rejects original bytes before JSON parsing', () => {
  expect(isExcalidrawText('{"elements":[],"type":"excalidraw/clipboard"}')).toBe(true);
  expect(isExcalidrawText('{"type":"whiteboard/clipboard"}')).toBe(false);
  expect(() => parseExcalidrawSource('not JSON', MAX_EXCALIDRAW_BYTES + 1)).toThrow('50 MiB');
  expect(() => parseExcalidrawSource('not JSON')).toThrow('valid JSON');
});
it('preserves onscreen coordinates and translates wholly offscreen strokes plus bound and unbound connector fallbacks', () => {
  const rect = createElement('rect', { id: 'r', x: 10000, y: 10000, w: 80, h: 50 });
  const stroke = createElement('stroke', { props: { points: [10000, 10000, .2, 10100, 10100, .9], simplified: true } });
  const connector = createElement('connector', { props: { start: bindToElement(rect, 1, .5), end: { x: 10200, y: 10200 }, kind: 'straight' } });
  const values = [rect, stroke, connector], viewport = { x: -500, y: -400, w: 1000, h: 800 }, placed = placeImportedElements(values, viewport), dx = placed[0]!.x - rect.x, dy = placed[0]!.y - rect.y;
  expect(placed[1]).toMatchObject({ props: { points: [10000 + dx, 10000 + dy, .2, 10100 + dx, 10100 + dy, .9] } });
  expect(placed[2]).toMatchObject({ props: { start: { fallback: { x: 10080 + dx, y: 10025 + dy } }, end: { x: 10200 + dx, y: 10200 + dy } } });
  expect(placeImportedElements(placed, viewport)).toEqual(placed); expect(values[0]!.x).toBe(10000);
});
it('replays a fitting import as one undo gesture, selects actual elements and preserves unrelated destination records', async () => {
  board.create('rect', { id: 'existing', index: 'b10' }); board.undoManager.clear();
  const { reports, release } = fixture(); await importer.importText(source(8));
  expect(board.readAll()).toHaveLength(9); expect(board.undoManager.undoStack).toHaveLength(1);
  expect(session.getState().selectedIds).toHaveLength(8); expect(reports.at(-1)).toMatchObject({ imported: 8, acknowledged: 8, pending: 0, batches: 1 });
  expect(board.readAll().filter(e => e.id !== 'existing').every(e => e.index > 'b10')).toBe(true);
  board.undoManager.undo(); expect(board.readAll().map(e => e.id)).toEqual(['existing']); board.undoManager.redo(); expect(board.readAll()).toHaveLength(9); expect(release).toHaveBeenCalledOnce();
});
it('preflights a single oversized element and storage limits without any live write or undo record', async () => {
  const { release } = fixture({ limit: 100 }); const before = Y.encodeStateAsUpdate(board.doc);
  await expect(importer.importText(source())).rejects.toThrow();
  expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0); expect(release).toHaveBeenCalledOnce();
});
it('waits for each actual acknowledgment before emitting another bounded batch and reports partial local additions honestly', async () => {
  let acknowledge!: () => void, calls = 0;
  const { reports, release } = fixture({ limit: 1600, acknowledgment: async () => { if (++calls === 1) await new Promise<void>(resolve => { acknowledge = resolve; }); else throw new Error('Disconnected'); } });
  const pending = importer.importText(source(15));
  await vi.waitFor(() => expect(calls).toBe(1)); const first = board.readAll().length;
  expect(first).toBeGreaterThan(0); expect(first).toBeLessThan(15);
  await Promise.resolve(); expect(board.readAll()).toHaveLength(first);
  acknowledge(); await expect(pending).rejects.toThrow('Disconnected');
  expect(reports.at(-1)).toMatchObject({ imported: board.readAll().length, acknowledged: first, pending: board.readAll().length - first, batches: 2 });
  expect(session.getState().selectedIds).toHaveLength(board.readAll().length); expect(board.undoManager.undoStack).toHaveLength(2); expect(release).toHaveBeenCalledOnce();
});
it('refreshes destination append indexes after asynchronous preparation', async () => {
  let calls = 0;
  fixture({ budget: async () => { if (++calls === 2) board.create('rect', { id: 'peer', index: 'b20' }); return { maxUpdateBytes: 4e6, maxBoardBytes: 64e6, maxInboundBytes: 8e6, maxClockGrowth: 1e6, snapshotBytes: 0, updateBytes: 0, stateVector: Y.encodeStateVector(board.doc) }; } });
  await importer.importText(source()); expect(board.readAll().filter(e => e.id !== 'peer')[0]!.index > 'b20').toBe(true);
});
it('checks read-only both before preparation and after every asynchronous budget response', async () => {
  let readOnly = false;
  const { release } = fixture({ readOnly: () => readOnly, budget: async () => { readOnly = true; return { maxUpdateBytes: 4e6, maxBoardBytes: 64e6, maxInboundBytes: 8e6, maxClockGrowth: 1e6, snapshotBytes: 0, updateBytes: 0, stateVector: Y.encodeStateVector(board.doc) }; } });
  await expect(importer.importText(source())).rejects.toThrow('read-only'); expect(board.readAll()).toEqual([]); expect(release).toHaveBeenCalledOnce();
});
it('refuses an unavailable renderer texture limit before decoding or uploading imported images', async () => {
  const upload = vi.spyOn(api, 'uploadAsset'), decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode); fixture({ imageLimit: NaN });
  const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: 'pixels', x: 0, y: 0, width: 10, height: 10 }], files: { pixels: { mimeType: 'image/png', dataURL: 'data:image/png;base64,' + Buffer.from(pngHeader(10, 10)).toString('base64') } } };
  await expect(importer.importText(JSON.stringify(scene))).rejects.toThrow('image limit is unavailable'); expect(upload).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(board.readAll()).toEqual([]);
});

it.each(['elements', 'images'] as const)('rejects excessive source %s before IDs, base64 decoding, pixel work, upload, live writes or undo', async kind => {
  const { reports } = fixture(), before = Y.encodeStateAsUpdate(board.doc), allocate = vi.spyOn(crypto, 'randomUUID');
  const base64 = vi.spyOn(globalThis, 'atob'), decode = vi.fn(), upload = vi.spyOn(api, 'uploadAsset'); vi.stubGlobal('createImageBitmap', decode);
  const json = kind === 'elements' ? source(10001) : JSON.stringify({ type: 'excalidraw', version: 2, elements: Array.from({ length: 101 }, (_, i) => ({ id: `image-${i}`, type: 'image', fileId: 'missing', x: 0, y: 0, width: 1, height: 1 })) });
  await expect(importer.importText(json)).rejects.toThrow(kind === 'elements' ? 'element count' : 'image count');
  expect(allocate).not.toHaveBeenCalled(); expect(base64).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0); expect(reports).toEqual([]);
});
it.each(['magic', 'mime', 'dimensions', 'bytes'] as const)('skips a hostile embedded image with bad %s before browser decoding or upload', async fault => {
  const { reports } = fixture(), before = Y.encodeStateAsUpdate(board.doc), decode = vi.fn(), upload = vi.spyOn(api, 'uploadAsset'); vi.stubGlobal('createImageBitmap', decode);
  const json = imageSource(fault === 'magic' ? new Uint8Array([1, 2, 3]) : fault === 'dimensions' ? pngHeader(16385, 1) : fault === 'bytes' ? new Uint8Array(20 * 1024 * 1024 + 1) : pngHeader(10, 10), fault === 'mime' ? 'image/jpeg' : 'image/png');
  const base64 = vi.spyOn(globalThis, 'atob'); await importer.importText(JSON.stringify(json));
  expect(reports.at(-1)).toMatchObject({ imported: 0, skipped: [{ id: 'image', type: 'image' }] });
  expect(reports.at(-1)!.skipped[0]!.reason).toMatch(fault === 'magic' ? /header/ : fault === 'mime' ? /MIME/ : fault === 'dimensions' ? /16384/ : /20 MiB/);
  if (fault === 'bytes') expect(base64).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0);
});
it.each([4096, 4097])('enforces an available 4096-pixel GPU cap for a %i-wide imported source', async width => {
  fixture({ imageLimit: 4096 }); const decode = vi.fn(async () => ({ width, height: 1, close: vi.fn() })); vi.stubGlobal('createImageBitmap', decode);
  const upload = vi.spyOn(api, 'uploadAsset').mockResolvedValue({ assetId: crypto.randomUUID(), width, height: 1 });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob: (done: (blob: Blob) => void) => done(new Blob([Uint8Array.from(pngHeader(width, 1))], { type: 'image/png' })) }) });
  const pending = importer.importText(JSON.stringify(imageSource(pngHeader(width, 1))));
  if (width === 4097) { await expect(pending).rejects.toThrow('texture limit'); expect(decode).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(board.readAll()).toEqual([]); expect(board.undoManager.undoStack).toHaveLength(0); }
  else { await pending; expect(decode).toHaveBeenCalledOnce(); expect(upload).toHaveBeenCalledOnce(); expect(board.readAll()[0]).toMatchObject({ props: { naturalW: 4096, naturalH: 1 } }); }
});
it.each(['label', 'points'] as const)('preflights every element before image I/O when a later %s is individually unsendable', async kind => {
  fixture({ limit: 2000 }); const before = Y.encodeStateAsUpdate(board.doc), decode = vi.fn(), upload = vi.spyOn(api, 'uploadAsset'); vi.stubGlobal('createImageBitmap', decode);
  const json: { elements: unknown[]; [key: string]: unknown } = imageSource();
  json.elements.push(kind === 'label' ? { id: 'large', type: 'text', x: 30, y: 0, width: 500, height: 50, text: 'x'.repeat(5000), fontFamily: 1 } : { id: 'large', type: 'freedraw', x: 30, y: 0, width: 1999, height: 1, points: Array.from({ length: 2000 }, (_, i) => [i, i % 2]), pressures: Array(2000).fill(.5) });
  const converted = importExcalidraw(json, { newId: () => crypto.randomUUID(), firstIndex: null }); expect(converted.elements).toHaveLength(2); expect(converted.report.skipped).toEqual([]);
  await expect(importer.importText(JSON.stringify(json))).rejects.toThrow(); expect(decode).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0);
});
it('destroying an import during a budget await releases its lease and never starts live writes', async () => {
  let finish!: (budget: ImportBudget) => void;
  const { release } = fixture({ budget: () => new Promise(resolve => { finish = resolve; }) }), before = Y.encodeStateAsUpdate(board.doc);
  const pending = importer.importText(source()); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); importer.destroy();
  finish({ maxUpdateBytes: 4e6, maxBoardBytes: 64e6, maxInboundBytes: 8e6, maxClockGrowth: 1e6, snapshotBytes: 0, updateBytes: 0, stateVector: Y.encodeStateVector(board.doc) });
  await expect(pending).rejects.toThrow('closed'); expect(release).toHaveBeenCalledOnce(); expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0);
});
