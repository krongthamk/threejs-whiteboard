import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createElement, type ElementOf } from '@whiteboard/model';
import { pngHeader } from '../../../tests/image-fixtures';
import { ImageProjection } from './images';

let projection: ImageProjection, group: THREE.Group;
const decode = vi.fn();
beforeEach(() => {
  group = new THREE.Group(); decode.mockReset();
  decode.mockResolvedValue({ width: 10, height: 10, close: vi.fn() }); vi.stubGlobal('createImageBitmap', decode);
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
