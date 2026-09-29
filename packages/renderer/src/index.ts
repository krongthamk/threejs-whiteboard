import * as THREE from 'three';
import RBush from 'rbush';
import { Text, configureTextBuilder, getCaretAtPoint, getSelectionRects } from 'troika-three-text';
import { arrowheadPoints, compareElements, connectorPoints, getElementBounds, rotatePoint, STICKY_TEXT_INSET, textLayout } from '@whiteboard/model';
import type { ElementOf, Point } from '@whiteboard/model';
import { createShapeBatch, cssColor, disposeMesh, rgba, updateShapeInstance } from './shapes';
import { createStrokeChunk, STROKES_PER_CHUNK } from './strokes';
import { SelectionOverlay, type SelectionState } from './selection';
import { LiveStroke } from './live-stroke';
import { PresenceProjection } from './presence';
import { ImageProjection } from './images';
import { syncTextAtlas, whenTextAtlasReady } from './text-atlas';
import type { Bounds, CameraState, PngOptions, RemotePresence, RenderElement, Renderer, RendererOptions, RendererStats } from './types';
export * from './types';
export { selectionHandles, type SelectionState, type SelectionFrame, type SelectionHandle } from './selection';

interface TextIndexEntry { minX: number; minY: number; maxX: number; maxY: number; id: string }
interface TextHandle { mesh: Text; ready: boolean; placeholder: THREE.Mesh; cancel: () => void; layout: ReturnType<typeof textLayout>; error?: Error }
interface StrokeChunk { ids: string[]; mesh: THREE.Mesh }
export interface TextCaret { charIndex: number; x: number; y: number; height: number }
let configuredFallbackFont: string | undefined;

/** A disposable projection. Every geometry and text handle can be rebuilt from the document. */
export class ThreeRenderer implements Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  readonly webgl: THREE.WebGLRenderer;
  readonly layers = Object.fromEntries(['grid', 'shapes', 'strokes', 'text', 'connectors', 'selectionUI', 'presence'].map(name => {
    const group = new THREE.Group(); group.name = name; return [name, group];
  })) as Record<'grid' | 'shapes' | 'strokes' | 'text' | 'connectors' | 'selectionUI' | 'presence', THREE.Group>;
  private elements = new Map<string, RenderElement>();
  private depths = new Map<string, number>();
  private shapeBatches = new Map<string, THREE.InstancedMesh>();
  private shapeSlots = new Map<string, number>();
  private translucentShapes = new Map<string, THREE.InstancedMesh>();
  private translucentStrokes = new Map<string, THREE.Mesh>();
  private strokeChunks: StrokeChunk[] = [];
  private textIndex = new RBush<TextIndexEntry>();
  private textHandles = new Map<string, TextHandle>();
  private visibleTextIds = new Set<string>();
  private pendingTexts = new Set<Promise<void>>();
  private queued = new Map<string, RenderElement | null>();
  private state: CameraState = { x: 0, y: 0, zoom: 1 };
  private width = 1;
  private height = 1;
  private viewportDirty = true;
  private chunkRebuilds = 0;
  private textErrorCount = 0;
  private disposed = false;
  private editingTextId: string | null = null;
  private selectionOverlay = new SelectionOverlay(this.layers.selectionUI);
  private liveStroke = new LiveStroke();
  private presence: PresenceProjection;
  private queuedPresence: readonly RemotePresence[] | null = null;
  private images: ImageProjection;
  private grid?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private placeholderGeometry = new THREE.PlaneGeometry(1, 1);
  private placeholderMaterial = new THREE.MeshBasicMaterial({ color: cssColor('#cbd5e1'), transparent: true, opacity: 0.3, depthWrite: false });

  constructor(private readonly options: RendererOptions) {
    const fallbackFont = new URL(options.fallbackFontUrl ?? 'noto-sans-jp-400.woff', new URL(options.fontUrl, document.baseURI)).href;
    if (!configuredFallbackFont) {
      configureTextBuilder({ defaultFontURL: fallbackFont }); configuredFallbackFont = fallbackFont;
    } else if (configuredFallbackFont !== fallbackFont) {
      throw new Error('Troika font configuration is shared: all renderers in a page must use the same fallbackFontUrl');
    }
    this.webgl = new THREE.WebGLRenderer({ canvas: options.canvas, alpha: true, antialias: true });
    this.webgl.setPixelRatio(options.pixelRatio ?? Math.min(globalThis.devicePixelRatio || 1, 2));
    this.webgl.setClearColor(cssColor(options.background ?? '#f8fafc'), 1);
    // The board is an unlit 2D compositor. Both framebuffer and PNG targets receive
    // CSS color components without a linear-light transfer, matching SVG opacity.
    // Keep global ColorManagement enabled for other three.js consumers.
    this.webgl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.camera.position.set(0, 0, 500);
    Object.values(this.layers).forEach(layer => this.scene.add(layer));
    this.layers.strokes.add(this.liveStroke.mesh);
    this.presence = new PresenceProjection(this.layers.presence, options.fontUrl, options.fontLoadTimeoutMs ?? 15000);
    const imageGroup = new THREE.Group(); imageGroup.name = 'images'; this.layers.shapes.add(imageGroup);
    this.images = new ImageProjection(imageGroup, options, this.webgl.capabilities.maxTextureSize);
    if (options.grid) this.createGrid();
    this.resize(options.canvas.clientWidth || 1200, options.canvas.clientHeight || 800);
  }

  private createGrid(): void {
    const material = new THREE.ShaderMaterial({
      uniforms: { spacing: { value: 24 }, zoom: { value: 1 } },
      vertexShader: 'varying vec2 world; void main(){vec4 p=modelMatrix*vec4(position,1.);world=p.xy;gl_Position=projectionMatrix*viewMatrix*p;}',
      fragmentShader: `varying vec2 world; uniform float spacing; uniform float zoom;
        void main(){vec2 p=mod(world+spacing*.5,spacing)-spacing*.5;
          float d=length(p)*zoom; float alpha=(1.-smoothstep(.5,1.2,d))*.2;
          gl_FragColor=vec4(.35,.4,.48,alpha);}`, transparent: true, depthWrite: false,
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.grid.position.z = -100;
    this.grid.renderOrder = -1;
    this.layers.grid.add(this.grid);
  }

  setElements(elements: readonly RenderElement[]): void {
    this.setSelection({});
    this.setLiveStroke(null);
    this.presence.clear();
    this.queuedPresence = null;
    this.clearProjection();
    this.elements = new Map(elements.map(element => [element.id, element]));
    this.queued.clear();
    this.rebuild(new Set(elements.map(element => element.id)), true);
  }

  applyDiff(upserts: readonly RenderElement[], removals: readonly string[] = []): void {
    for (const element of upserts) this.queued.set(element.id, element);
    for (const id of removals) this.queued.set(id, null);
  }

  private flush(): void {
    if (!this.queued.size) return;
    const changed = new Set(this.queued.keys());
    let orderingChanged = false;
    for (const [id, value] of this.queued) {
      const previous = this.elements.get(id);
      if (!previous || !value || previous.index !== value.index || previous.type !== value.type || (previous.style.opacity < 1) !== (value.style.opacity < 1)) orderingChanged = true;
      if (value) this.elements.set(id, value); else this.elements.delete(id);
      this.disposeText(id);
    }
    this.queued.clear();
    this.rebuild(changed, orderingChanged);
  }

  private rebuild(changed: Set<string>, orderingChanged: boolean): void {
    const ordered = [...this.elements.values()].sort(compareElements);
    if (orderingChanged) {
      this.depths.clear();
      this.shapeSlots.clear();
      ordered.forEach((element, index) => this.depths.set(element.id, index / Math.max(1, ordered.length) * 100));
    }
    for (const type of ['rect', 'ellipse', 'sticky']) {
      const shapes = ordered.filter(element => element.type === type && element.style.opacity === 1);
      const old = this.shapeBatches.get(type);
      if (!orderingChanged && old && shapes.length === old.count) {
        let updated = false;
        for (const shape of shapes) if (changed.has(shape.id)) {
          const slot = this.shapeSlots.get(shape.id);
          if (slot !== undefined) { updateShapeInstance(old, slot, shape, this.depths.get(shape.id) ?? 0); updated = true; }
        }
        if (updated) old.computeBoundingSphere();
        continue;
      }
      // Batches own only GPU data, never document state.
      if (old) disposeMesh(old);
      this.shapeBatches.delete(type);
      if (shapes.length) {
        const mesh = createShapeBatch(shapes, this.depths);
        shapes.forEach((shape, index) => this.shapeSlots.set(shape.id, index));
        this.shapeBatches.set(type, mesh); this.layers.shapes.add(mesh);
      }
    }
    const translucentShapes = ordered.filter(element => ['rect', 'ellipse', 'sticky'].includes(element.type) && element.style.opacity < 1);
    this.updateTranslucent(translucentShapes, this.translucentShapes, this.layers.shapes, changed, orderingChanged, createShapeBatch);
    const translucentStrokes = ordered.filter(element => element.type === 'stroke' && element.style.opacity < 1);
    this.updateTranslucent(translucentStrokes, this.translucentStrokes, this.layers.strokes, changed, orderingChanged, createStrokeChunk);
    const strokes = ordered.filter(element => element.type === 'stroke' && element.style.opacity === 1);
    const nextChunks: StrokeChunk[] = [];
    for (let offset = 0; offset < strokes.length; offset += STROKES_PER_CHUNK) {
      const chunkElements = strokes.slice(offset, offset + STROKES_PER_CHUNK);
      const ids = chunkElements.map(element => element.id);
      const previous = this.strokeChunks[offset / STROKES_PER_CHUNK];
      const reusable = !orderingChanged && previous && previous.ids.length === ids.length && ids.every((id, i) => id === previous.ids[i] && !changed.has(id));
      if (reusable) nextChunks.push(previous);
      else {
        if (previous) disposeMesh(previous.mesh);
        const mesh = createStrokeChunk(chunkElements, this.depths);
        this.layers.strokes.add(mesh); nextChunks.push({ ids, mesh }); this.chunkRebuilds++;
      }
    }
    for (let i = nextChunks.length; i < this.strokeChunks.length; i++) disposeMesh(this.strokeChunks[i]!.mesh);
    this.strokeChunks = nextChunks;
    this.textIndex.clear();
    this.textIndex.load(ordered.filter(element => element.type === 'text' || element.type === 'sticky').map(element => {
      const box = getElementBounds(element);
      return { id: element.id, minX: box.x, minY: box.y, maxX: box.x + box.w, maxY: box.y + box.h };
    }));
    for (const [id, handle] of this.textHandles) {
      if (!this.elements.has(id)) this.disposeText(id);
      else {
        handle.mesh.position.z = (this.depths.get(id) ?? 0) + 0.001;
        handle.mesh.renderOrder = 1000 + handle.mesh.position.z;
      }
    }
    this.rebuildConnectors(ordered.filter(element => element.type === 'connector'));
    this.images.set(ordered.filter((element): element is ElementOf<'image'> => element.type === 'image'), this.depths);
    this.presence.updateDocument(this.elements);
    this.viewportDirty = true;
  }

  private updateTranslucent<T extends THREE.Mesh>(elements: RenderElement[], handles: Map<string, T>, group: THREE.Group, changed: Set<string>, orderingChanged: boolean,
    create: (elements: readonly RenderElement[], depths: Map<string, number>) => T): void {
    const ids = new Set(elements.map(element => element.id));
    for (const [id, mesh] of handles) if (!ids.has(id)) { disposeMesh(mesh); handles.delete(id); }
    for (const element of elements) if (!handles.has(element.id) || changed.has(element.id) || orderingChanged) {
      const old = handles.get(element.id); if (old) disposeMesh(old);
      const mesh = create([element], this.depths); handles.set(element.id, mesh); group.add(mesh);
    }
  }

  private rebuildConnectors(elements: RenderElement[]): void {
    for (const child of [...this.layers.connectors.children]) disposeMesh(child as THREE.Mesh);
    this.buildConnectorMeshes(elements.filter(element => element.style.opacity === 1), false);
    for (const element of elements) if (element.style.opacity < 1) this.buildConnectorMeshes([element], true);
  }

  private buildConnectorMeshes(elements: RenderElement[], translucent: boolean): void {
    if (!elements.length) return;
    const positions: number[] = [], colors: number[] = [];
    const arrowGeometry = new THREE.BufferGeometry();
    arrowGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -1, -.45, 0, -1, .45, 0], 3));
    const arrowColors = new Float32Array(elements.length * 4);
    arrowGeometry.setAttribute('tint', new THREE.InstancedBufferAttribute(arrowColors, 4));
    const arrowMaterial = new THREE.ShaderMaterial({
      vertexShader: 'attribute vec4 tint; varying vec4 color; void main(){color=tint;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec4 color; void main(){gl_FragColor=color;\n#include <colorspace_fragment>\n}',
      transparent: translucent, side: THREE.DoubleSide, depthFunc: THREE.LessDepth,
    });
    const arrows = new THREE.InstancedMesh(arrowGeometry, arrowMaterial, elements.length);
    const arrowTransform = new THREE.Object3D(); let arrowIndex = 0;
    const addTriangle = (a: Point, b: Point, c: Point, element: RenderElement) => {
      const tint = rgba(element.style.stroke, element.style.opacity), z = this.depths.get(element.id) ?? 0;
      for (const p of [a, b, c]) { positions.push(p.x, -p.y, z); colors.push(...tint); }
    };
    for (const element of elements) {
      const points = connectorPoints(element, this.elements);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const dx = -(b.y - a.y) / length * element.style.strokeWidth / 2;
        const dy = (b.x - a.x) / length * element.style.strokeWidth / 2;
        const p = { x: a.x + dx, y: a.y + dy }, q = { x: b.x + dx, y: b.y + dy };
        const r = { x: b.x - dx, y: b.y - dy }, s = { x: a.x - dx, y: a.y - dy };
        addTriangle(p, q, r, element); addTriangle(p, r, s, element);
      }
      // The SVG stroke uses round caps and joins. A disk at each path vertex
      // unions with the segment quads, including a connector with one point.
      // LessDepth + depthWrite keeps coplanar overlap from applying opacity twice.
      const radius = element.style.strokeWidth / 2;
      if (radius > 0) {
        // Keep chord error below half a pixel at 64× zoom / 2× pixel ratio for
        // normal stroke widths; cap work for pathological imported stroke sizes.
        const segments = Math.max(16, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - .5 / (radius * 128))))));
        const ring = Array.from({ length: segments }, (_, step) => ({ x: Math.cos(step / segments * Math.PI * 2) * radius, y: Math.sin(step / segments * Math.PI * 2) * radius }));
        for (const point of points) for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
          addTriangle(point, { x: point.x + a.x, y: point.y + a.y }, { x: point.x + b.x, y: point.y + b.y }, element);
        }
      }
      const arrow = arrowheadPoints(element, this.elements);
      if (arrow.length === 3) {
        const tip = arrow[0]!, base = { x: (arrow[1]!.x + arrow[2]!.x) / 2, y: (arrow[1]!.y + arrow[2]!.y) / 2 };
        const size = Math.hypot(tip.x - base.x, tip.y - base.y);
        arrowTransform.position.set(tip.x, -tip.y, this.depths.get(element.id) ?? 0);
        arrowTransform.rotation.z = -Math.atan2(tip.y - base.y, tip.x - base.x);
        arrowTransform.scale.set(size, size, 1); arrowTransform.updateMatrix();
        arrows.setMatrixAt(arrowIndex, arrowTransform.matrix); arrowColors.set(rgba(element.style.stroke, element.style.opacity), arrowIndex * 4); arrowIndex++;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('tint', new THREE.Float32BufferAttribute(colors, 4));
    const material = new THREE.ShaderMaterial({
      vertexShader: 'attribute vec4 tint; varying vec4 color; void main(){color=tint;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec4 color; void main(){gl_FragColor=color;\n#include <colorspace_fragment>\n}',
      transparent: translucent, side: THREE.DoubleSide, depthFunc: THREE.LessDepth,
    });
    const renderOrder = translucent ? 1000 + (this.depths.get(elements[0]!.id) ?? 0) : 4;
    const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = renderOrder; this.layers.connectors.add(mesh);
    arrows.count = arrowIndex; arrows.renderOrder = renderOrder; arrows.computeBoundingSphere(); this.layers.connectors.add(arrows);
  }

  setCamera(state: CameraState): void {
    this.state = { x: state.x, y: state.y, zoom: Math.max(.02, Math.min(64, state.zoom)) };
    this.selectionOverlay.setZoom(this.state.zoom);
    this.presence.setZoom(this.state.zoom);
    this.camera.position.x = state.x; this.camera.position.y = -state.y;
    this.camera.zoom = this.state.zoom; this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
    if (this.grid) {
      this.grid.position.x = state.x; this.grid.position.y = -state.y;
      this.grid.scale.set(this.width / this.state.zoom, this.height / this.state.zoom, 1);
      this.grid.material.uniforms.zoom!.value = this.state.zoom;
      this.grid.material.uniforms.spacing!.value = 24 * Math.pow(2, Math.max(0, Math.ceil(Math.log2(.5 / this.state.zoom))));
    }
    this.viewportDirty = true;
  }

  getCamera(): CameraState { return { ...this.state }; }
  setSelection(selection: SelectionState): void { this.selectionOverlay.set(selection, this.state.zoom); }
  setLiveStroke(element: ElementOf<'stroke'> | null): void { this.liveStroke.set(element); }
  /** Awareness may arrive hundreds of times per second; project only the latest frame. */
  setPresence(presences: readonly RemotePresence[]): void { this.queuedPresence = presences; }
  getImageError(id: string): Error | undefined { return this.images.getError(id); }
  getMaxImageDimension(): number { return this.webgl.capabilities.maxTextureSize; }
  resize(width: number, height: number): void {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.webgl.setSize(this.width, this.height, false);
    this.camera.left = -this.width / 2; this.camera.right = this.width / 2;
    this.camera.top = this.height / 2; this.camera.bottom = -this.height / 2;
    this.setCamera(this.state);
  }

  private viewport(): Bounds {
    return { x: this.state.x - this.width / this.state.zoom / 2, y: this.state.y - this.height / this.state.zoom / 2,
      w: this.width / this.state.zoom, h: this.height / this.state.zoom };
  }

  private updateVisibleTexts(bounds = this.viewport(), zoom = this.state.zoom): void {
    this.images.updateVisible(bounds, zoom, this.webgl.getPixelRatio());
    const visible = new Set<string>();
    const entries = this.textIndex.search({ minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.w, maxY: bounds.y + bounds.h });
    for (const entry of entries) {
      const element = this.elements.get(entry.id)!;
      if ((element.type !== 'text' && element.type !== 'sticky') || !element.props.text || element.style.fontSize * zoom < 6 || entry.id === this.editingTextId) continue;
      visible.add(entry.id);
      const handle = this.textHandles.get(entry.id) ?? this.createText(element);
      if (handle.mesh.parent !== this.layers.text) this.layers.text.add(handle.mesh, handle.placeholder);
      handle.mesh.visible = handle.ready; handle.placeholder.visible = !handle.ready;
    }
    for (const id of this.visibleTextIds) if (!visible.has(id)) {
      const handle = this.textHandles.get(id); handle?.mesh.removeFromParent(); handle?.placeholder.removeFromParent();
    }
    this.visibleTextIds = visible;
    this.viewportDirty = false;
  }

  private createText(element: RenderElement & { type: 'text' | 'sticky' }): TextHandle {
    const mesh = new Text();
    const layout = textLayout(element);
    mesh.text = layout.text; mesh.font = element.style.fontFamily.toLowerCase().includes('mono') ? this.options.monoFontUrl ?? this.options.fontUrl : this.options.fontUrl;
    mesh.fontSize = element.style.fontSize; mesh.color = cssColor(element.style.color);
    mesh.fillOpacity = element.style.opacity; mesh.textAlign = element.props.align;
    const inset = element.type === 'sticky' ? STICKY_TEXT_INSET : 0;
    mesh.maxWidth = Infinity;
    mesh.lineHeight = 1.25; mesh.overflowWrap = 'break-word';
    mesh.anchorX = element.props.align; mesh.anchorY = 'top-baseline';
    const alignOffset = element.props.align === 'left' ? inset : element.props.align === 'right' ? element.w - inset : element.w / 2;
    const p = rotatePoint({ x: element.x + alignOffset, y: element.y + inset + element.style.fontSize }, { x: element.x + element.w / 2, y: element.y + element.h / 2 }, element.rotation);
    mesh.position.set(p.x, -p.y, (this.depths.get(element.id) ?? 0) + .001);
    mesh.rotation.z = -element.rotation;
    mesh.renderOrder = 1000 + mesh.position.z; mesh.visible = false; mesh.material.depthWrite = false;
    const placeholder = new THREE.Mesh(this.placeholderGeometry, this.placeholderMaterial);
    placeholder.position.set(element.x + element.w / 2, -element.y - element.h / 2, mesh.position.z);
    placeholder.scale.set(Math.max(1, element.w), Math.max(1, element.h), 1); placeholder.rotation.z = -element.rotation;
    placeholder.renderOrder = mesh.renderOrder;
    const handle: TextHandle = { mesh, ready: false, placeholder, cancel: () => {}, layout };
    this.textHandles.set(element.id, handle);
    const ready = new Promise<void>((resolve, reject) => {
      const cancel = syncTextAtlas(mesh, this.options.fontLoadTimeoutMs ?? 15000, () => {
        if (!this.disposed && this.textHandles.get(element.id) === handle) {
          handle.ready = true; mesh.visible = this.visibleTextIds.has(element.id); placeholder.visible = false;
        }
        resolve();
      }, error => {
        handle.error = error; this.textErrorCount++; reject(error);
      });
      handle.cancel = () => { cancel(); resolve(); };
    });
    this.pendingTexts.add(ready); void ready.then(() => this.pendingTexts.delete(ready), () => this.pendingTexts.delete(ready));
    return handle;
  }

  setEditingText(id: string | null): void { this.editingTextId = id; this.viewportDirty = true; }
  getTextObject(id: string): Text | undefined { return this.textHandles.get(id)?.mesh; }
  getTextError(id: string): Error | undefined { return this.textHandles.get(id)?.error; }
  getTextCaret(id: string, point: Point): TextCaret | null {
    const handle = this.textHandles.get(id);
    if (!handle?.ready || !handle.mesh.textRenderInfo) return null;
    handle.mesh.updateMatrixWorld();
    const local = handle.mesh.worldToLocal(new THREE.Vector3(point.x, -point.y, handle.mesh.position.z));
    const caret = getCaretAtPoint(handle.mesh.textRenderInfo, local.x, local.y);
    if (!caret) return null;
    const world = handle.mesh.localToWorld(new THREE.Vector3(caret.x, caret.y, 0));
    return { charIndex: handle.layout.renderedToSource[caret.charIndex] ?? caret.charIndex, x: world.x, y: -world.y, height: caret.height };
  }
  getTextSelectionRects(id: string, start: number, end: number): Bounds[] {
    const handle = this.textHandles.get(id);
    if (!handle?.ready || !handle.mesh.textRenderInfo) return [];
    handle.mesh.updateMatrixWorld();
    const sourceToRendered = handle.layout.sourceToRendered;
    const renderStart = sourceToRendered[Math.max(0, Math.min(sourceToRendered.length - 1, start))] ?? start;
    const renderEnd = sourceToRendered[Math.max(0, Math.min(sourceToRendered.length - 1, end))] ?? end;
    return getSelectionRects(handle.mesh.textRenderInfo, renderStart, renderEnd).map(rect => {
      const corners = [[rect.left, rect.top], [rect.left, rect.bottom], [rect.right, rect.top], [rect.right, rect.bottom]]
        .map(([x, y]) => handle.mesh.localToWorld(new THREE.Vector3(x, y, 0)));
      const xs = corners.map(p => p.x), ys = corners.map(p => -p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    });
  }

  render(): void {
    if (this.disposed) return;
    this.flush();
    if (this.queuedPresence) { this.presence.set(this.queuedPresence, this.elements, this.state.zoom); this.queuedPresence = null; }
    if (this.viewportDirty) this.updateVisibleTexts(); this.webgl.render(this.scene, this.camera);
  }

  async whenReady(): Promise<void> {
    this.flush(); if (this.viewportDirty) this.updateVisibleTexts();
    while (this.pendingTexts.size) await Promise.all(this.pendingTexts);
    for (const id of this.visibleTextIds) { const error = this.textHandles.get(id)?.error; if (error) throw error; }
    await this.images.whenReady();
  }

  async exportPng({ bounds, scale = 2, transparent = false }: PngOptions): Promise<Blob> {
    if (!(bounds.w > 0 && bounds.h > 0 && scale > 0)) throw new Error('PNG bounds and scale must be positive');
    this.flush();
    const width = Math.ceil(bounds.w * scale), height = Math.ceil(bounds.h * scale);
    const output = document.createElement('canvas'); output.width = width; output.height = height;
    const context = output.getContext('2d'); if (!context) throw new Error('Canvas 2D unavailable');
    const maxSize = this.webgl.capabilities.maxTextureSize;
    const clear = this.webgl.getClearColor(new THREE.Color()), alpha = this.webgl.getClearAlpha();
    const gridVisible = this.layers.grid.visible, selectionVisible = this.layers.selectionUI.visible, presenceVisible = this.layers.presence.visible, liveStrokeVisible = this.liveStroke.mesh.visible;
    const editing = this.editingTextId; this.editingTextId = null;
    this.layers.grid.visible = this.layers.selectionUI.visible = this.layers.presence.visible = false;
    this.liveStroke.mesh.visible = false;
    this.images.setExporting(true);
    this.webgl.setClearColor(clear, transparent ? 0 : 1);
    try {
      for (let top = 0; top < height; top += maxSize) for (let left = 0; left < width; left += maxSize) {
        const tileWidth = Math.min(maxSize, width - left), tileHeight = Math.min(maxSize, height - top);
        const tileBounds = { x: bounds.x + left / scale, y: bounds.y + top / scale, w: tileWidth / scale, h: tileHeight / scale };
        this.updateVisibleTexts(tileBounds, scale); await this.whenReady();
        // A main-canvas text sync may own glyph generation needed by this export.
        // Await the current shared work even if this renderer's own sync is done.
        await whenTextAtlasReady();
        const camera = this.camera.clone(); camera.zoom = 1;
        camera.left = -tileBounds.w / 2; camera.right = tileBounds.w / 2; camera.top = tileBounds.h / 2; camera.bottom = -tileBounds.h / 2;
        camera.position.set(tileBounds.x + tileBounds.w / 2, -tileBounds.y - tileBounds.h / 2, 500); camera.updateProjectionMatrix();
        const target = new THREE.WebGLRenderTarget(tileWidth, tileHeight, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, samples: 4 });
        target.texture.colorSpace = THREE.LinearSRGBColorSpace;
        try {
          this.webgl.setRenderTarget(target); this.webgl.render(this.scene, camera);
          const pixels = new Uint8Array(tileWidth * tileHeight * 4); this.webgl.readRenderTargetPixels(target, 0, 0, tileWidth, tileHeight, pixels);
          // Blending accumulates premultiplied components in a transparent target;
          // ImageData expects straight alpha, or translucent exports become dark.
          if (transparent) for (let p = 0; p < pixels.length; p += 4) {
            const opacity = pixels[p + 3]!;
            if (opacity > 0 && opacity < 255) for (let c = 0; c < 3; c++) pixels[p + c] = Math.min(255, Math.round(pixels[p + c]! * 255 / opacity));
          }
          // Alpha-to-coverage shapes can leave fractional alpha in covered MSAA
          // samples. The resolved RGB already includes the opaque clear color;
          // keep those colors and mark the explicitly opaque export as opaque.
          else for (let p = 3; p < pixels.length; p += 4) pixels[p] = 255;
          const flipped = new Uint8ClampedArray(pixels.length), stride = tileWidth * 4;
          for (let row = 0; row < tileHeight; row++) flipped.set(pixels.subarray(row * stride, (row + 1) * stride), (tileHeight - row - 1) * stride);
          context.putImageData(new ImageData(flipped, tileWidth, tileHeight), left, top);
        } finally { this.webgl.setRenderTarget(null); target.dispose(); }
      }
      return await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
    } finally {
      this.webgl.setClearColor(clear, alpha); this.layers.grid.visible = gridVisible;
      this.layers.selectionUI.visible = selectionVisible; this.layers.presence.visible = presenceVisible;
      this.liveStroke.mesh.visible = liveStrokeVisible;
      this.images.setExporting(false);
      this.editingTextId = editing; this.viewportDirty = true; this.render();
    }
  }

  stats(): RendererStats {
    return { calls: this.webgl.info.render.calls, triangles: this.webgl.info.render.triangles, geometries: this.webgl.info.memory.geometries,
      textures: this.webgl.info.memory.textures, elements: this.elements.size,
      shapeInstances: [...this.shapeBatches.values(), ...this.translucentShapes.values()].reduce((n, mesh) => n + mesh.count, 0), strokeChunks: this.strokeChunks.length,
      strokeChunkRebuilds: this.chunkRebuilds, textInstances: this.textHandles.size, visibleTexts: this.visibleTextIds.size, pendingTexts: this.pendingTexts.size,
      textErrors: this.textErrorCount, ...this.presence.stats(), ...this.images.stats() };
  }

  private disposeText(id: string): void {
    const handle = this.textHandles.get(id); if (!handle) return;
    if (handle.error) this.textErrorCount--;
    handle.cancel(); handle.mesh.removeFromParent(); handle.mesh.dispose(); handle.placeholder.removeFromParent(); this.textHandles.delete(id);
  }
  private clearProjection(): void {
    this.images.clear();
    for (const mesh of this.shapeBatches.values()) disposeMesh(mesh); this.shapeBatches.clear();
    for (const mesh of this.translucentShapes.values()) disposeMesh(mesh); this.translucentShapes.clear();
    for (const mesh of this.translucentStrokes.values()) disposeMesh(mesh); this.translucentStrokes.clear();
    this.shapeSlots.clear();
    for (const chunk of this.strokeChunks) disposeMesh(chunk.mesh); this.strokeChunks = [];
    for (const id of this.textHandles.keys()) this.disposeText(id); this.visibleTextIds.clear();
    for (const mesh of [...this.layers.connectors.children]) disposeMesh(mesh as THREE.Mesh);
    this.textIndex.clear();
  }
  dispose(): void {
    this.disposed = true; this.clearProjection(); this.selectionOverlay.dispose(); this.liveStroke.dispose(); this.placeholderGeometry.dispose(); this.placeholderMaterial.dispose();
    this.images.dispose(); this.presence.dispose();
    this.queuedPresence = null;
    if (this.grid) disposeMesh(this.grid); this.webgl.dispose();
  }
}

export function createRenderer(options: RendererOptions): ThreeRenderer { return new ThreeRenderer(options); }
