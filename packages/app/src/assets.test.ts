import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BoardDocument } from '@whiteboard/model';
import { pngHeader } from '../../../tests/image-fixtures';
import { api } from './api';
import { BoardAssets } from './assets';
import { createSession } from './session';
import { ExcalidrawImporter } from './excalidraw-import';

let board: BoardDocument, assets: BoardAssets, errors: string[];
let session: ReturnType<typeof createSession>;
const decode = vi.fn();
beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  decode.mockReset(); decode.mockResolvedValue({ width: 10, height: 10, close: vi.fn() });
  vi.stubGlobal('createImageBitmap', decode);
  board = new BoardDocument(); session = createSession('target'); errors = [];
  assets = new BoardAssets({ canvas: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getBoundingClientRect: () => ({ width: 1000, height: 800 }) } as unknown as HTMLCanvasElement,
    boardId: 'target', board, session, isReadOnly: () => false, maxImageDimension: () => 16384, onError: message => errors.push(message) });
});
afterEach(() => { assets.destroy(); session.dispose(); board.destroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const file = (width: number, height: number) => new File([pngHeader(width, height) as Uint8Array<ArrayBuffer>], 'test.png', { type: 'image/png' });

test('client rejects oversized image headers before invoking a browser decoder or upload', async () => {
  const upload = vi.spyOn(api, 'uploadAsset');
  await assets.importFiles([file(30000, 30000)]);
  expect(errors).toHaveLength(1); expect(decode).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(board.readAll()).toEqual([]);
});
test('client inserts dimensions validated and returned by the server', async () => {
  vi.spyOn(api, 'uploadAsset').mockResolvedValue({ assetId: 'uploaded', width: 10, height: 10 });
  await assets.importFiles([file(10, 10)]);
  expect(errors).toEqual([]); expect(board.readAll()[0]).toMatchObject({ type: 'image', props: { assetId: 'uploaded', naturalW: 10, naturalH: 10 } });
});
test('client refuses inconsistent server dimensions without inserting a partial import', async () => {
  vi.spyOn(api, 'uploadAsset').mockResolvedValue({ assetId: 'uploaded', width: 1, height: 1 });
  await assets.importFiles([file(10, 10)]);
  expect(errors[0]).toContain('inconsistent'); expect(board.readAll()).toEqual([]);
});

test.each(['target', 'another-board'])('clipboard validates actual asset dimensions for source %s before insertion', async sourceBoardId => {
  const { createElement } = await import('@whiteboard/model');
  const { parseClipboard } = await import('./clipboard-model');
  const envelope = parseClipboard(JSON.stringify({ type: 'whiteboard/clipboard', version: 1, sourceBoardId,
    elements: [createElement('image', { props: { assetId: 'forged-source', naturalW: 1, naturalH: 1 } })] }))!;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([pngHeader(10, 10) as Uint8Array<ArrayBuffer>], { type: 'image/png' }))));
  vi.spyOn(api, 'copyAsset').mockResolvedValue({ assetId: 'copied', width: 10, height: 10 });
  await (assets as unknown as { importClipboard(value: typeof envelope): Promise<void> }).importClipboard(envelope);
  expect(errors[0]).toContain('do not match'); expect(board.readAll()).toEqual([]); expect(decode).not.toHaveBeenCalled();
});

test('closing while an Excalidraw file is being read prevents preparation, uploads and document changes', async () => {
  const text = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'source', type: 'rectangle', x: 0, y: 0, width: 20, height: 30 }] });
  const documentFile = new File([text], 'scene.excalidraw', { type: 'application/json' });
  let finish!: (text: string) => void; vi.spyOn(documentFile, 'text').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const upload = vi.spyOn(api, 'uploadAsset'), allocate = vi.spyOn(crypto, 'randomUUID'), preparation = vi.spyOn(ExcalidrawImporter.prototype, 'importText'), before = board.readAll();
  const pending = assets.importFiles([documentFile]); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); assets.destroy();
  finish(text); await pending;
  expect(preparation).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(board.readAll()).toEqual(before); expect(board.undoManager.undoStack).toHaveLength(0); expect(errors).toEqual([]);
});
