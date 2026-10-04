import { afterEach, expect, it, vi } from 'vitest';
import { normalizeImageOrientation } from './image-orientation';
vi.mock('@whiteboard/renderer', async () => await import('../../renderer/src/abort'));
afterEach(() => vi.unstubAllGlobals());

const header = { mimeType: 'image/jpeg' as const, width: 80, height: 40, orientation: 2 };
function fixture(output = new Blob(['normalized'], { type: 'image/png' })) {
  const bitmap = { width: 80, height: 40, close: vi.fn() };
  const drawImage = vi.fn(), canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (done: (blob: Blob) => void) => done(output) };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  return { bitmap, canvas, drawImage };
}
it('retains ordinary bytes and performs no pixel allocation', async () => {
  const { orientation, ...ordinary } = header, blob = new Blob(['original']);
  vi.stubGlobal('document', { createElement: vi.fn() });
  expect(await normalizeImageOrientation(blob, ordinary)).toBe(blob);
  expect(document.createElement).not.toHaveBeenCalled();
});
it('normalizes validated display pixels, closes the bitmap and releases the scratch canvas', async () => {
  const { bitmap, canvas, drawImage } = fixture();
  const blob = await normalizeImageOrientation(new Blob(), header);
  expect(blob.type).toBe('image/png'); expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
});
it('rejects normalized bytes over 20 MiB and closes all pixel resources', async () => {
  const { bitmap, canvas } = fixture(new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]));
  await expect(normalizeImageOrientation(new Blob(), header)).rejects.toThrow('normalized image exceeds the 20 MiB');
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(canvas.width).toBe(0);
});
it('rejects unsafe or inconsistent dimensions before storing normalized bytes', async () => {
  const { bitmap } = fixture();
  await expect(normalizeImageOrientation(new Blob(), { ...header, width: 16385 })).rejects.toThrow('16384');
  expect(createImageBitmap).not.toHaveBeenCalled();
  await expect(normalizeImageOrientation(new Blob(), { ...header, width: 81 })).rejects.toThrow('inconsistent encoded dimensions');
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it('cancels promptly and closes a bitmap that finishes decoding after cancellation', async () => {
  const { bitmap, canvas } = fixture(), controller = new AbortController();
  let finish!: (bitmap: unknown) => void;
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const pending = normalizeImageOrientation(new Blob(), header, controller.signal);
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  finish(bitmap); await Promise.resolve(); await Promise.resolve();
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(canvas.width).toBe(0);
});
