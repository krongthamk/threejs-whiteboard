import * as THREE from 'three';
import RBush from 'rbush';
import { getElementBounds, readImageHeader, assertSafeImageDimensions, MAX_IMAGE_BYTES, type ImageHeader, type ElementOf } from '@whiteboard/model';
import { cssColor } from './shapes';
import type { Bounds, RendererOptions } from './types';

type ImageElement = ElementOf<'image'>;
interface Entry { id: string; minX: number; minY: number; maxX: number; maxY: number }
interface TextureResource { texture: THREE.Texture; bitmap: ImageBitmap; size: number }
interface Asset {
  id: string; controller: AbortController; source?: Promise<Blob>; display?: TextureResource; full?: TextureResource;
  displayTask?: Promise<void>; fullTask?: Promise<void>; desiredSize: number; header?: ImageHeader; error?: Error; fullError?: Error;
}
interface Handle { element: ImageElement; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; error?: Error }

/** Immutable sources stay outside the model; only visible images allocate textures. */
export class ImageProjection {
  private elements = new Map<string, ImageElement>();
  private handles = new Map<string, Handle>();
  private assets = new Map<string, Asset>();
  private index = new RBush<Entry>();
  private visibleIds = new Set<string>();
  private depths: ReadonlyMap<string, number> = new Map();
  private geometry = new THREE.PlaneGeometry(1, 1);
  private pending = new Set<Promise<void>>();
  private exporting = false;
  private disposed = false;
  private viewport: Bounds = { x: 0, y: 0, w: 0, h: 0 };
  private zoom = 1;
  private pixelRatio = 1;
  constructor(private group: THREE.Group, private options: RendererOptions, private maxTextureSize: number, private invalidate: () => void = () => {}) {}

  set(elements: readonly ImageElement[], depths: ReadonlyMap<string, number>): void {
    this.elements = new Map(elements.map(element => [element.id, element])); this.depths = depths;
    this.index.clear();
    this.index.load(elements.map(element => { const b = getElementBounds(element); return { id: element.id, minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h }; }));
    for (const [id, handle] of this.handles) {
      const element = this.elements.get(id);
      if (!element) { this.removeHandle(handle); this.handles.delete(id); this.visibleIds.delete(id); }
      else { handle.element = element; this.transform(handle); }
    }
    const used = new Set(elements.map(element => element.props.assetId));
    for (const [id, asset] of this.assets) if (!used.has(id)) this.removeAsset(asset);
  }
  updateVisible(bounds: Bounds, zoom: number, pixelRatio: number): void {
    if (this.disposed) return;
    this.viewport = bounds; this.zoom = zoom; this.pixelRatio = pixelRatio;
    const visible = new Set<string>(), demands = new Map<string, { element: ImageElement; size: number }>();
    for (const entry of this.index.search({ minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.w, maxY: bounds.y + bounds.h })) {
      const element = this.elements.get(entry.id)!; visible.add(entry.id);
      let handle = this.handles.get(entry.id);
      if (!handle) {
        const material = new THREE.MeshBasicMaterial({ color: cssColor('#dce3ed'), transparent: true, depthWrite: false, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(this.geometry, material); this.group.add(mesh);
        handle = { element, mesh }; this.handles.set(element.id, handle); this.transform(handle);
      }
      handle.mesh.visible = true;
      const naturalSize = Math.max(element.props.naturalW, element.props.naturalH);
      const requested = Math.max(element.w / element.props.naturalW, element.h / element.props.naturalH) * naturalSize * zoom * pixelRatio;
      const size = Math.min(naturalSize, this.options.maxDisplayImageSize ?? 2048, this.maxTextureSize, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, requested)))));
      const previous = demands.get(element.props.assetId);
      if (!previous || previous.size < size) demands.set(element.props.assetId, { element, size });
    }
    for (const id of this.visibleIds) if (!visible.has(id)) { const handle = this.handles.get(id); if (handle) handle.mesh.visible = false; }
    this.visibleIds = visible;
    for (const [id, { element, size }] of demands) {
      let asset = this.assets.get(id);
      if (!asset) { asset = { id, controller: new AbortController(), desiredSize: size }; this.assets.set(id, asset); }
      asset.desiredSize = Math.max(asset.desiredSize, size);
      this.ensureTexture(asset, element, this.exporting);
      this.bindAsset(asset);
    }
    // Keep display resources while export visits other tiles; otherwise release offscreen assets.
    if (!this.exporting) for (const asset of [...this.assets.values()]) if (!demands.has(asset.id)) this.removeAsset(asset);
  }
  private transform(handle: Handle): void {
    const e = handle.element, depth = this.depths.get(e.id) ?? 0;
    handle.mesh.position.set(e.x + e.w / 2, -e.y - e.h / 2, depth);
    handle.mesh.rotation.z = -e.rotation; handle.mesh.scale.set(e.w, e.h, 1); handle.mesh.renderOrder = 1000 + depth;
    handle.mesh.material.opacity = e.style.opacity;
  }
  private async source(asset: Asset): Promise<Blob> {
    if (!asset.source) asset.source = (async () => {
      if (!this.options.resolveAsset) throw new Error(`No asset resolver is configured for image ${asset.id}`);
      const url = await this.options.resolveAsset(asset.id);
      if (asset.controller.signal.aborted) throw new Error(`Image ${asset.id} load was cancelled`);
      const response = await fetch(url, { signal: asset.controller.signal });
      if (!response.ok) throw new Error(`Image ${asset.id} request failed (${response.status})`);
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) throw new Error(`Image ${asset.id} exceeds the 20 MiB limit`);
      const header = readImageHeader(new Uint8Array(await blob.arrayBuffer()));
      assertSafeImageDimensions(header.width, header.height);
      asset.header = header;
      return blob;
    })();
    return asset.source;
  }
  private validDimensions(element: ImageElement, header: ImageHeader): boolean {
    return element.props.naturalW === header.width && element.props.naturalH === header.height;
  }
  private hasValidInstance(asset: Asset): boolean {
    return !!asset.header && [...this.visibleIds].some(id => {
      const element = this.handles.get(id)?.element;
      return !!element && element.props.assetId === asset.id && this.validDimensions(element, asset.header!);
    });
  }
  private ensureTexture(asset: Asset, element: ImageElement, full: boolean): void {
    if (asset.header && !this.hasValidInstance(asset)) { this.bindAsset(asset); return; }
    if (full ? asset.full || asset.fullTask || asset.fullError : asset.error || asset.displayTask || (asset.display && asset.display.size >= asset.desiredSize)) return;
    const work = (async () => {
      const blob = await this.source(asset), header = asset.header!;
      this.bindAsset(asset);
      // Metadata belongs to an immutable asset; declarations belong to each instance.
      // One forged instance cannot borrow a valid texture or poison another instance.
      if (!this.hasValidInstance(asset)) return null;
      const size = full ? Math.max(header.width, header.height) : asset.desiredSize;
      const ratio = size / Math.max(header.width, header.height);
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none',
        ...(!full ? { resizeWidth: Math.max(1, Math.round(header.width * ratio)), resizeHeight: Math.max(1, Math.round(header.height * ratio)), resizeQuality: 'high' as const } : {}) });
      if (asset.controller.signal.aborted || this.disposed || this.assets.get(asset.id) !== asset) { bitmap.close(); throw new Error(`Image ${asset.id} load was cancelled`); }
      if (bitmap.width > this.maxTextureSize || bitmap.height > this.maxTextureSize) { bitmap.close(); throw new Error(`Image ${asset.id} exceeds the GPU's ${this.maxTextureSize}px texture limit for full-resolution export`); }
      const texture = new THREE.Texture(bitmap); texture.colorSpace = THREE.NoColorSpace; texture.flipY = false; texture.needsUpdate = true;
      texture.generateMipmaps = !full; texture.minFilter = full ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
      return { bitmap, texture, size };
    })();
    const tracked = this.bounded(work, asset).then(resource => {
      if (!resource) { this.bindAsset(asset); return; }
      if (this.disposed || this.assets.get(asset.id) !== asset) { this.disposeTexture(resource); return; }
      if (full && !this.exporting) { this.disposeTexture(resource); return; }
      if (full) { if (asset.full) this.disposeTexture(asset.full); asset.full = resource; }
      else { if (asset.display) this.disposeTexture(asset.display); asset.display = resource; }
      this.bindAsset(asset);
    }, error => {
      if (this.disposed || this.assets.get(asset.id) !== asset) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      if (full) asset.fullError = failure; else asset.error = failure;
      this.bindAsset(asset);
    }).finally(() => {
      this.pending.delete(tracked);
      if (full) asset.fullTask = undefined; else asset.displayTask = undefined;
      if (!full && !asset.error && asset.display && asset.display.size < asset.desiredSize && this.assets.get(asset.id) === asset) this.ensureTexture(asset, element, false);
    });
    if (full) asset.fullTask = tracked; else asset.displayTask = tracked;
    this.pending.add(tracked);
  }
  private bounded(work: Promise<TextureResource | null>, asset: Asset): Promise<TextureResource | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); asset.controller.signal.removeEventListener('abort', aborted); callback(); };
      const aborted = () => finish(() => reject(new Error(`Image ${asset.id} load was cancelled`)));
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Image ${asset.id} failed to load within ${this.options.imageLoadTimeoutMs ?? 15000} ms`)));
        asset.controller.abort();
      }, this.options.imageLoadTimeoutMs ?? 15000);
      asset.controller.signal.addEventListener('abort', aborted, { once: true });
      if (asset.controller.signal.aborted) aborted();
      work.then(resource => { if (settled) { if (resource) this.disposeTexture(resource); } else finish(() => resolve(resource)); }, error => finish(() => reject(error)));
    });
  }
  private bindAsset(asset: Asset): void {
    const resource = this.exporting ? asset.full : asset.display, error = this.exporting ? asset.fullError : asset.error;
    let changed = false;
    for (const id of this.visibleIds) {
      const handle = this.handles.get(id); if (!handle || handle.element.props.assetId !== asset.id) continue;
      const mismatch = asset.header && !this.validDimensions(handle.element, asset.header)
        ? new Error(`Image ${asset.id} dimensions do not match this element`) : undefined;
      if (handle.error?.message !== (mismatch ?? error)?.message) changed = true;
      handle.error = mismatch ?? error;
      const material = handle.mesh.material, texture = handle.error ? null : resource?.texture ?? null;
      if (material.map !== texture) { material.map = texture; material.needsUpdate = true; changed = true; }
      const color = cssColor(texture ? '#ffffff' : handle.error ? '#fee2e2' : '#dce3ed');
      if (!material.color.equals(color)) { material.color.copy(color); changed = true; }
    }
    if (changed) this.invalidate();
  }
  setExporting(exporting: boolean): void {
    this.exporting = exporting;
    if (!exporting) for (const asset of this.assets.values()) { if (asset.full) this.disposeTexture(asset.full); asset.full = undefined; asset.fullError = undefined; this.bindAsset(asset); }
  }
  async whenReady(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
    for (const id of this.visibleIds) { const error = this.handles.get(id)?.error; if (error) throw error; }
  }
  getError(id: string): Error | undefined { return this.handles.get(id)?.error; }
  stats(): { imageInstances: number; visibleImages: number; pendingImages: number; imageErrors: number } {
    let imageErrors = 0; for (const id of this.visibleIds) if (this.handles.get(id)?.error) imageErrors++;
    return { imageInstances: this.handles.size, visibleImages: this.visibleIds.size, pendingImages: this.pending.size, imageErrors };
  }
  private disposeTexture(resource: TextureResource): void { resource.texture.dispose(); resource.bitmap.close(); }
  private removeAsset(asset: Asset): void {
    this.assets.delete(asset.id); asset.controller.abort();
    if (asset.display) this.disposeTexture(asset.display); if (asset.full) this.disposeTexture(asset.full);
    for (const handle of this.handles.values()) if (handle.element.props.assetId === asset.id) { handle.mesh.material.map = null; handle.mesh.material.needsUpdate = true; }
  }
  private removeHandle(handle: Handle): void { handle.mesh.removeFromParent(); handle.mesh.material.dispose(); }
  clear(): void {
    for (const handle of this.handles.values()) this.removeHandle(handle); this.handles.clear();
    for (const asset of [...this.assets.values()]) this.removeAsset(asset);
    this.elements.clear(); this.index.clear(); this.visibleIds.clear();
  }
  dispose(): void { this.disposed = true; this.clear(); this.geometry.dispose(); }
}
