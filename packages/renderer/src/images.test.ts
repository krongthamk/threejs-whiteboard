import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createElement, type ElementOf } from '@whiteboard/model';
import { pngHeader } from '../../../tests/image-fixtures';
import { ImageProjection } from './images';

let projection: ImageProjection, group: THREE.Group;
const decode = vi.fn();
beforeEach(() => {
  group = new THREE.Group(); decode.mockReset();
  decode.mockImplementation(async () => ({ width: 10, height: 10, close: vi.fn() })); vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([pngHeader(10, 10) as Uint8Array<ArrayBuffer>], { type: 'image/png' }))));
  projection = new ImageProjection(group, { canvas: {} as HTMLCanvasElement, fontUrl: '/font', resolveAsset: id => `/asset/${id}` }, 16384);
});
afterEach(() => { projection.dispose(); vi.unstubAllGlobals(); });
function image(id: string, width = 10, height = 10): ElementOf<'image'> {
  return createElement('image', { id, props: { assetId: 'shared', naturalW: width, naturalH: height }, x: 0, y: 0, w: 100, h: 100 });
}
function show(elements: ElementOf<'image'>[]) { projection.set(elements, new Map()); projection.updateVisible({ x: -1, y: -1, w: 1000, h: 1000 }, 1, 1); }

test('renderer rejects oversized source headers before image decoding', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([pngHeader(30000, 30000) as Uint8Array<ArrayBuffer>], { type: 'image/png' }))));
  show([image('bomb')]); await expect(projection.whenReady()).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled(); expect(projection.getError('bomb')).toBeDefined();
});
test('renderer rejects declared dimensions before decoding a sole mismatched instance', async () => {
  show([image('forged', 1, 1)]); await expect(projection.whenReady()).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});
test('cached source dimensions are checked for every instance without poisoning a valid shared image', async () => {
  show([image('valid')]); await projection.whenReady(); expect(decode).toHaveBeenCalledOnce();
  show([image('valid'), image('forged', 1, 1)]); await expect(projection.whenReady()).rejects.toThrow();
  expect(projection.getError('valid')).toBeUndefined(); expect(projection.getError('forged')).toBeDefined();
  const meshes = group.children as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  expect(meshes[0]!.material.map).not.toBeNull(); expect(meshes[1]!.material.map).toBeNull();
  expect(decode).toHaveBeenCalledOnce();
});


test('retains an edge texture inside the viewport margin and closes it beyond that margin', async () => {
  show([image('edge')]); await projection.whenReady();
  const mesh = group.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, texture = mesh.material.map!;
  const bitmap = await decode.mock.results[0]!.value;
  projection.updateVisible({ x: 102, y: 0, w: 100, h: 100 }, 1, 1);
  expect(projection.stats().visibleImages).toBe(0); expect(bitmap.close).not.toHaveBeenCalled();
  projection.updateVisible({ x: 90, y: 0, w: 100, h: 100 }, 1, 1); await projection.whenReady();
  expect(mesh.material.map).toBe(texture); expect(decode).toHaveBeenCalledOnce();
  projection.updateVisible({ x: 127, y: 0, w: 100, h: 100 }, 1, 1);
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(mesh.material.map).toBeNull();
});
test('image handles have bounded offscreen LRU membership and recreate on reentry', async () => {
  projection.dispose(); projection = new ImageProjection(group, { canvas: {} as HTMLCanvasElement, fontUrl: '/font', resolveAsset: id => `/asset/${id}`, offscreenImageCacheSize: 2 }, 16384);
  const images = Array.from({ length: 5 }, (_, n) => ({ ...image(`region-${n}`), x: n * 2000 }));
  projection.set(images, new Map());
  const visit = async (n: number) => { projection.updateVisible({ x: n * 2000, y: 0, w: 100, h: 100 }, 1, 1); await projection.whenReady(); };
  await visit(0); const zero = group.children[0]; await visit(1); const one = group.children[1]!; const disposal = vi.spyOn((one as THREE.Mesh).material as THREE.Material, 'dispose');
  await visit(0); await visit(2); await visit(3);
  expect(projection.stats().imageInstances).toBe(3); expect(group.children).toContain(zero); expect(group.children).not.toContain(one); expect(disposal).toHaveBeenCalledOnce();
  await visit(1); expect(projection.stats().imageInstances).toBe(3); expect(group.children).not.toContain(one); expect(projection.stats().visibleImages).toBe(1);
});
test('a retained offscreen producer cannot block readiness for the exact visible viewport', async () => {
  let finish!: (bitmap: unknown) => void;
  decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  show([image('edge')]); await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  projection.updateVisible({ x: 102, y: 0, w: 100, h: 100 }, 1, 1);
  const result = await Promise.race([projection.whenReady().then(() => 'ready'), new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 20))]);
  expect(result).toBe('ready');
  projection.dispose(); const bitmap = { width: 10, height: 10, close: vi.fn() }; finish(bitmap);
  await Promise.resolve(); await Promise.resolve(); expect(bitmap.close).toHaveBeenCalledOnce();
});

test('direct export pins the original display thumbnail across distant tiles and restores it', async () => {
  show([image('original'), { ...image('distant'), x: 2000, props: { ...image('distant').props, assetId: 'distant' } }]); await projection.whenReady();
  const original = group.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, thumbnail = original.material.map!;
  const originalBitmap = await decode.mock.results[0]!.value;
  projection.setExporting(true); projection.updateVisible({ x: 2000, y: 0, w: 100, h: 100 }, 1, 1); await projection.whenReady();
  expect(originalBitmap.close).not.toHaveBeenCalled(); expect(projection.stats().visibleImages).toBe(1);
  projection.setExporting(false); projection.updateVisible({ x: 0, y: 0, w: 100, h: 100 }, 1, 1); await projection.whenReady();
  expect(original.material.map).toBe(thumbnail); expect(originalBitmap.close).not.toHaveBeenCalled();
});

test('an evicted source that ignores cancellation cannot clear its replacement texture', async () => {
  const oldBlob = new Blob([pngHeader(10, 10) as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  let finish!: (bytes: ArrayBuffer) => void;
  const read = vi.spyOn(oldBlob, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, blob: async () => oldBlob })
    .mockImplementation(async () => new Response(new Blob([pngHeader(10, 10) as Uint8Array<ArrayBuffer>], { type: 'image/png' })));
  vi.stubGlobal('fetch', fetch);
  show([image('same')]); await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  projection.updateVisible({ x: 2000, y: 0, w: 100, h: 100 }, 1, 1);
  projection.updateVisible({ x: 0, y: 0, w: 100, h: 100 }, 1, 1); await projection.whenReady();
  const mesh = group.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, texture = mesh.material.map!;
  expect(texture).not.toBeNull(); expect(decode).toHaveBeenCalledOnce();
  finish(pngHeader(10, 10).buffer as ArrayBuffer);
  await new Promise<void>(resolve => setTimeout(resolve, 0)); // Drain the canceled producer's microtasks.
  expect(mesh.material.map).toBe(texture); expect(decode).toHaveBeenCalledOnce();
  expect(projection.stats().pendingImages).toBe(0); expect(projection.getError('same')).toBeUndefined();
});
