import { bindToElement, compareElements, contentBounds, createElement, deriveElementGeometry, resolveBinding, rotatePoint, type Binding, type BoardDocument, type Element, type ElementOf, type Point } from '@whiteboard/model';
import { selectionHandles, type CameraState, type SelectionFrame, type SelectionHandle, type ThreeRenderer } from '@whiteboard/renderer';
import { HitIndex, selectionFrame } from './hit-test';
import type { SessionStore, Tool } from './session';
import { simplifyStroke } from './stroke-input';

interface Options {
  canvas: HTMLCanvasElement; board: BoardDocument; renderer: ThreeRenderer; session: SessionStore;
  onEditText(id: string): void; isReadOnly(): boolean;
}
interface PointerGesture { pointerId: number; start: Point; clientStart: Point; point: Point; moved: boolean }
type Gesture = PointerGesture & (
  | { kind: 'create'; element: Element }
  | { kind: 'draw'; element: ElementOf<'stroke'>; points: number[] }
  | { kind: 'eraser'; erased: Set<string> }
  | { kind: 'move'; ids: string[]; delta: Point }
  | { kind: 'pan'; camera: CameraState }
  | { kind: 'marquee'; previous: string[]; additive: boolean }
  | { kind: 'transform'; ids: string[]; frame: SelectionFrame; handle: SelectionHandle; initial: Map<string, Element>; shift: boolean }
);
const clampZoom = (zoom: number) => Math.max(.02, Math.min(64, zoom));
const boxBetween = (a: Point, b: Point) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
const interactiveTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,button,a,summary,[contenteditable="true"],[role="textbox"],[role="button"]');

/** Session gestures project previews; only completed gestures enter the document. */
export class EditorController {
  readonly hitIndex: HitIndex;
  private gesture: Gesture | null = null;
  private touches = new Map<number, Point>();
  private pinch: { ids: [number, number]; distance: number; zoom: number; anchor: Point } | null = null;
  private preview = new Map<string, Element>();
  private selectionCache: { elements: Element[]; frame: SelectionFrame | null; outlines: SelectionFrame[] } | null = null;
  private selectionIds = new Set<string>();
  private space = false;
  private destroyed = false;
  private unsubscribeBoard: () => void;
  private unsubscribeSession: () => void;
  private previousTouchAction: string;

  constructor(private readonly options: Options) {
    const { canvas, board, session } = options;
    this.hitIndex = new HitIndex(board.readAll());
    this.previousTouchAction = canvas.style.touchAction; canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.addEventListener('lostpointercapture', this.pointerCancel);
    canvas.addEventListener('dblclick', this.doubleClick);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('keydown', this.keyDown); window.addEventListener('keyup', this.keyUp); window.addEventListener('blur', this.blur);
    this.unsubscribeBoard = board.subscribe(({ ids }) => {
      const upserts: Element[] = [], removals: string[] = [];
      for (const id of ids) { const element = board.read(id); if (element) upserts.push(element); else removals.push(id); }
      const changed = this.hitIndex.apply(upserts, removals);
      if ([...changed].some(id => this.selectionIds.has(id))) this.selectionCache = null;
      if (this.gesture && this.gesture.kind !== 'create') this.projectGesture();
      else this.refreshSelection();
    });
    this.unsubscribeSession = session.subscribe((state, previous) => {
      if (state.tool !== previous.tool) this.cancelGesture();
      if (state.selectedIds !== previous.selectedIds) { this.selectionIds = new Set(state.selectedIds); this.selectionCache = null; }
      if (state.selectedIds !== previous.selectedIds || state.camera !== previous.camera) this.refreshSelection();
      this.updateCursor();
    });
    this.selectionIds = new Set(session.getState().selectedIds);
    this.refreshSelection(); this.updateCursor();
  }

  private world(client: Point): Point {
    const bounds = this.options.canvas.getBoundingClientRect(), camera = this.options.session.getState().camera;
    return { x: camera.x + (client.x - bounds.left - bounds.width / 2) / camera.zoom, y: camera.y + (client.y - bounds.top - bounds.height / 2) / camera.zoom };
  }
  private selected(): Element[] { return this.options.session.getState().selectedIds.flatMap(id => { const element = this.preview.get(id) ?? this.hitIndex.elements.get(id); return element ? [element] : []; }); }
  private refreshSelection(marquee?: ReturnType<typeof boxBetween>): void {
    const { frame, outlines } = this.cachedSelection();
    this.options.renderer.setSelection({
      outlines,
      frame: this.options.isReadOnly() ? null : frame, marquee,
      ...(this.options.isReadOnly() && frame ? { outlines: [frame] } : {}),
    });
  }
  private cachedSelection(): { elements: Element[]; frame: SelectionFrame | null; outlines: SelectionFrame[] } {
    if (!this.selectionCache) {
      const elements = this.selected(), projection = this.projectionElements();
      this.selectionCache = { elements, frame: selectionFrame(elements, projection),
        outlines: elements.length > 1 ? elements.map(element => selectionFrame([element], projection)!) : [] };
    }
    return this.selectionCache;
  }
  private projectionElements(): ReadonlyMap<string, Element> {
    if (!this.preview.size) return this.hitIndex.elements;
    return new Map([...this.hitIndex.elements, ...this.preview]);
  }
  private select(ids: string[]): void { this.options.session.setState({ selectedIds: [...new Set(ids)] }); }
  private snapped(point: Point): Point { return this.options.session.getState().snap ? { x: Math.round(point.x / 24) * 24, y: Math.round(point.y / 24) * 24 } : point; }
  private handleAt(point: Point): SelectionHandle | null {
    const frame = this.cachedSelection().frame; if (!frame || this.options.isReadOnly()) return null;
    const zoom = this.options.session.getState().camera.zoom;
    // Corners win over edge handles when zoom makes a small selection crowded.
    const handles = selectionHandles(frame, zoom).sort((a, b) => (a.kind.length === 2 ? 0 : 1) - (b.kind.length === 2 ? 0 : 1));
    return handles.find(handle => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) * zoom <= 7)?.kind ?? null;
  }
  private nextIndex(): string { return this.options.board.nextIndex(); }
  private connectorAnchor(point: Point): Binding {
    const zoom = this.options.session.getState().camera.zoom;
    const hit = this.hitIndex.hit(point, 16 / zoom);
    if (!hit || hit.type === 'connector' || hit.type === 'stroke') return point;
    const anchors = [[.5, 0], [1, .5], [.5, 1], [0, .5]] as const;
    const bindings = anchors.map(([nx, ny]) => bindToElement(hit, nx, ny));
    return bindings.sort((a, b) => { const pa = resolveBinding(a, this.hitIndex.elements), pb = resolveBinding(b, this.hitIndex.elements); return Math.hypot(pa.x - point.x, pa.y - point.y) - Math.hypot(pb.x - point.x, pb.y - point.y); })[0]!;
  }

  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const { canvas, session, isReadOnly } = this.options;
    if (event.pointerType === 'touch') {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      if (this.touches.size >= 2) {
        canvas.focus({ preventScroll: true }); event.preventDefault();
        // Restore any edit preview, retaining capture for both navigation fingers.
        this.cancelGesture(false);
        if (!this.pinch) this.beginPinch();
        this.updateCursor(); return;
      }
    } else if (this.touches.size) return;
    if (this.gesture) return;
    const point = this.world({ x: event.clientX, y: event.clientY }), state = session.getState();
    const common: PointerGesture = { pointerId: event.pointerId, start: point, point, clientStart: { x: event.clientX, y: event.clientY }, moved: false };
    canvas.focus({ preventScroll: true }); event.preventDefault();
    if (event.button === 1 || this.space || state.tool === 'pan') {
      this.gesture = { ...common, kind: 'pan', camera: { ...state.camera } };
    } else if (state.tool === 'draw' && !isReadOnly()) {
      const pressure = event.pointerType === 'mouse' ? .5 : event.pressure;
      const points = [point.x, point.y, pressure];
      const element = createElement('stroke', { index: this.nextIndex(), style: state.style, props: { points, simplified: false } });
      this.gesture = { ...common, kind: 'draw', element, points };
      this.select([]); this.options.renderer.setLiveStroke(element);
    } else if (state.tool === 'eraser' && !isReadOnly()) {
      this.gesture = { ...common, kind: 'eraser', erased: new Set() }; this.select([]); this.eraseSegment(point, point);
    } else if (state.tool === 'connector' && !isReadOnly()) {
      const start = this.connectorAnchor(point);
      const element = createElement('connector', { index: this.nextIndex(), style: state.style, props: { start, end: point, kind: state.connectorKind } });
      this.gesture = { ...common, kind: 'create', element };
      this.preview.set(element.id, element); this.options.renderer.applyDiff([element]); this.select([element.id]);
    } else if (state.tool === 'text' && !isReadOnly()) {
      const hit = this.hitIndex.hit(point, 0);
      if (hit?.type === 'text' || hit?.type === 'sticky') { this.select([hit.id]); session.setState({ tool: 'select' }); this.options.onEditText(hit.id); return; }
      const element = createElement('text', { ...point, index: this.nextIndex(), style: state.style });
      this.gesture = { ...common, kind: 'create', element };
      this.preview.set(element.id, element); this.options.renderer.applyDiff([element]); this.select([element.id]);
    } else if (['rect', 'ellipse', 'sticky'].includes(state.tool) && !isReadOnly()) {
      const type = state.tool as 'rect' | 'ellipse' | 'sticky', start = this.snapped(point);
      const element = createElement(type, { ...start, index: this.nextIndex(), w: 1, h: 1, style: { ...state.style, ...(type === 'sticky' && state.style.fill === '#ffffff' ? { fill: '#fff0a8' } : {}) } }) as Element;
      this.gesture = { ...common, start, kind: 'create', element };
      this.preview.set(element.id, element); this.options.renderer.applyDiff([element]); this.select([element.id]);
    } else if (state.tool === 'select') {
      const handle = this.handleAt(point), frame = this.cachedSelection().frame;
      if (handle && frame) {
        const initial = new Map(this.selected().map(element => [element.id, element]));
        this.gesture = { ...common, kind: 'transform', ids: [...initial.keys()], initial, frame, handle, shift: event.shiftKey };
      } else {
        const hit = this.hitIndex.hit(point, 4 / state.camera.zoom);
        if (hit) {
          const already = state.selectedIds.includes(hit.id);
          if (event.shiftKey) this.select(already ? state.selectedIds.filter(id => id !== hit.id) : [...state.selectedIds, hit.id]);
          else if (!already) this.select([hit.id]);
          if (!isReadOnly() && (!event.shiftKey || !already)) this.gesture = { ...common, kind: 'move', ids: [...session.getState().selectedIds], delta: { x: 0, y: 0 } };
        } else {
          const previous = [...state.selectedIds]; if (!event.shiftKey) this.select([]);
          this.gesture = { ...common, kind: 'marquee', previous, additive: event.shiftKey };
        }
      }
    }
    if (this.gesture) canvas.setPointerCapture(event.pointerId);
    this.updateCursor(point);
  };

  private pointerMove = (event: PointerEvent): void => {
    if (this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch) { event.preventDefault(); this.movePinch(); return; }
    }
    const point = this.world({ x: event.clientX, y: event.clientY });
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) { this.updateCursor(point); return; }
    event.preventDefault(); const previousPoint = gesture.point; gesture.point = point;
    gesture.moved ||= Math.hypot(event.clientX - gesture.clientStart.x, event.clientY - gesture.clientStart.y) >= 3;
    if (gesture.kind === 'draw') {
      this.appendStrokeSamples(event); return;
    } else if (gesture.kind === 'eraser') {
      this.eraseSegment(previousPoint, point); return;
    } else if (gesture.kind === 'pan') {
      this.options.session.setState({ camera: { ...gesture.camera, x: gesture.camera.x - (event.clientX - gesture.clientStart.x) / gesture.camera.zoom, y: gesture.camera.y - (event.clientY - gesture.clientStart.y) / gesture.camera.zoom } });
    } else {
      if (gesture.kind === 'move') gesture.delta = this.snapped({ x: point.x - gesture.start.x, y: point.y - gesture.start.y });
      if (gesture.kind === 'transform') gesture.shift = event.shiftKey;
      this.projectGesture();
    }
  };

  private beginPinch(): void {
    const entries = [...this.touches];
    if (entries.length < 2) { this.pinch = null; return; }
    const [first, second] = entries as [[number, Point], [number, Point], ...[number, Point][]];
    const center = { x: (first[1].x + second[1].x) / 2, y: (first[1].y + second[1].y) / 2 };
    this.pinch = { ids: [first[0], second[0]], distance: Math.max(1, Math.hypot(first[1].x - second[1].x, first[1].y - second[1].y)),
      zoom: this.options.session.getState().camera.zoom, anchor: this.world(center) };
  }
  private movePinch(): void {
    const pinch = this.pinch; if (!pinch) return;
    const first = this.touches.get(pinch.ids[0]), second = this.touches.get(pinch.ids[1]);
    if (!first || !second) return;
    const zoom = clampZoom(pinch.zoom * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance);
    const bounds = this.options.canvas.getBoundingClientRect();
    this.options.session.setState({ camera: {
      x: pinch.anchor.x - ((first.x + second.x) / 2 - bounds.left - bounds.width / 2) / zoom,
      y: pinch.anchor.y - ((first.y + second.y) / 2 - bounds.top - bounds.height / 2) / zoom, zoom,
    } });
  }
  private endTouch(id: number): boolean {
    const navigating = !!this.pinch;
    if (!this.touches.delete(id)) return false;
    if (this.pinch?.ids.includes(id)) this.beginPinch();
    this.releasePointer(id); this.updateCursor();
    return navigating;
  }

  private appendStrokeSamples(event: PointerEvent): void {
    const gesture = this.gesture; if (gesture?.kind !== 'draw') return;
    const zoom = this.options.session.getState().camera.zoom;
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event]) {
      const point = this.world({ x: sample.clientX, y: sample.clientY }), last = gesture.points.length - 3;
      const pressure = sample.pointerType === 'mouse' ? .5 : sample.type === 'pointerup' ? gesture.points[last + 2]! : sample.pressure;
      if (Math.hypot(point.x - gesture.points[last]!, point.y - gesture.points[last + 1]!) * zoom < .25 && Math.abs(pressure - gesture.points[last + 2]!) < .02) continue;
      gesture.points.push(point.x, point.y, pressure);
    }
    gesture.element = deriveElementGeometry({ ...gesture.element, props: { ...gesture.element.props, points: gesture.points } }) as ElementOf<'stroke'>;
    this.options.renderer.setLiveStroke(gesture.element);
  }
  private eraseSegment(start: Point, end: Point): void {
    const gesture = this.gesture; if (gesture?.kind !== 'eraser') return;
    for (const element of this.hitIndex.strokesAlong(start, end, 6 / this.options.session.getState().camera.zoom)) {
      gesture.erased.add(element.id); this.preview.set(element.id, element);
    }
    this.options.renderer.applyDiff([], [...gesture.erased]);
  }

  private projectGesture(): void {
    const gesture = this.gesture; if (!gesture) return;
    if (gesture.kind === 'draw') return;
    if (gesture.kind === 'eraser') { this.options.renderer.applyDiff([], [...gesture.erased]); return; }
    if (gesture.kind === 'marquee') {
      const box = boxBetween(gesture.start, gesture.point);
      this.select([...(gesture.additive ? gesture.previous : []), ...this.hitIndex.within(box).map(element => element.id)]);
      this.refreshSelection(box); return;
    }
    if (gesture.kind === 'pan') return;
    const elements: Element[] = [];
    if (gesture.kind === 'create') {
      const box = boxBetween(gesture.start, this.snapped(gesture.point));
      elements.push(gesture.element.type === 'connector' ? { ...gesture.element, props: { ...gesture.element.props, end: this.connectorAnchor(gesture.point) } } :
        { ...gesture.element, ...box, w: Math.max(1, box.w), h: Math.max(1, box.h) });
    } else if (gesture.moved) {
      for (const id of gesture.ids) {
        const latest = this.hitIndex.elements.get(id); if (!latest) continue;
        elements.push(gesture.kind === 'move' ? translateElement(latest, gesture.delta) : transformElement(latest, { ...gesture, elements: this.hitIndex.elements }));
      }
    }
    const nextPreview = new Map(elements.map(element => [element.id, element]));
    const removals = [...this.preview.keys()].filter(id => !nextPreview.has(id));
    this.preview = nextPreview;
    this.selectionCache = null;
    this.options.renderer.applyDiff(elements, removals.filter(id => !this.hitIndex.elements.has(id)));
    this.refreshSelection();
  }

  private pointerUp = (event: PointerEvent): void => {
    if (this.endTouch(event.pointerId)) return;
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.pointerMove(event);
    this.gesture = null;
    let editTextId: string | null = null;
    if (!this.options.isReadOnly()) {
      if (gesture.kind === 'draw') {
        const points = simplifyStroke(gesture.points, .35 / this.options.session.getState().camera.zoom);
        this.options.board.create('stroke', { ...gesture.element, index: undefined, props: { points, simplified: true } });
      } else if (gesture.kind === 'eraser') {
        if (gesture.erased.size) this.options.board.delete([...gesture.erased]);
      } else if (gesture.kind === 'create') {
        const draft = this.preview.get(gesture.element.id) ?? gesture.element;
        let element = gesture.moved ? draft : { ...draft, w: draft.type === 'sticky' ? 200 : 160, h: draft.type === 'sticky' ? 160 : 100 };
        if (element.type === 'text') { element = { ...element, props: { ...element.props, autoSize: !gesture.moved } }; editTextId = element.id; }
        if (element.type === 'connector' && !gesture.moved) { this.restorePreview(); this.releasePointer(gesture.pointerId); return; }
        this.options.board.create(element.type, { ...element, index: undefined });
        this.select([element.id]); this.options.session.setState({ tool: 'select' });
      } else if (gesture.kind === 'move' && gesture.moved && (gesture.delta.x || gesture.delta.y)) {
        this.options.board.move(gesture.ids, gesture.delta);
      } else if (gesture.kind === 'transform' && gesture.moved) {
        this.options.board.updateMany(gesture.ids.flatMap(id => {
          const element = this.options.board.read(id); if (!element) return [];
          const transformed = transformElement(element, { ...gesture, elements: this.hitIndex.elements });
          return [{ id, patch: { x: transformed.x, y: transformed.y, w: transformed.w, h: transformed.h, rotation: transformed.rotation,
            ...((transformed.type === 'stroke' || transformed.type === 'connector' || transformed.type === 'text') ? { props: transformed.props } : {}) } }];
        }));
      }
    }
    this.options.renderer.setLiveStroke(null);
    this.restorePreview(); this.releasePointer(gesture.pointerId); this.updateCursor();
    if (editTextId) this.options.onEditText(editTextId);
  };
  private releasePointer(id: number): void { if (this.options.canvas.hasPointerCapture(id)) this.options.canvas.releasePointerCapture(id); }
  private pointerCancel = (event: PointerEvent): void => {
    if (event.type === 'lostpointercapture' && this.options.canvas.hasPointerCapture(event.pointerId)) return;
    this.endTouch(event.pointerId);
    if (this.gesture?.pointerId === event.pointerId) this.cancelGesture();
  };
  private restorePreview(): void {
    const upserts: Element[] = [], removals: string[] = [];
    for (const id of this.preview.keys()) { const element = this.options.board.read(id); if (element) upserts.push(element); else removals.push(id); }
    if (this.preview.size) this.selectionCache = null;
    this.preview.clear(); this.options.renderer.applyDiff(upserts, removals);
    const selectedIds = this.options.session.getState().selectedIds;
    if (selectedIds.some(id => !this.hitIndex.elements.has(id))) this.select(selectedIds.filter(id => this.hitIndex.elements.has(id)));
    this.refreshSelection();
  }
  private cancelGesture(releaseCapture = true): void {
    const gesture = this.gesture; this.gesture = null;
    this.options.renderer.setLiveStroke(null);
    if (gesture?.kind === 'marquee') this.select(gesture.previous);
    this.restorePreview();
    if (releaseCapture) {
      this.pinch = null;
      const ids = [...this.touches.keys()]; this.touches.clear();
      for (const id of ids) this.releasePointer(id);
      if (gesture) this.releasePointer(gesture.pointerId);
    }
    this.updateCursor();
  }
  private blur = (): void => { this.space = false; this.cancelGesture(); };
  private doubleClick = (event: MouseEvent): void => {
    if (this.options.isReadOnly()) return;
    const element = this.hitIndex.hit(this.world({ x: event.clientX, y: event.clientY }), 0);
    if (element?.type === 'text' || element?.type === 'sticky') { this.select([element.id]); this.options.onEditText(element.id); }
  };
  private wheel = (event: WheelEvent): void => {
    event.preventDefault(); if (this.gesture) return;
    const state = this.options.session.getState(), factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.options.canvas.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      this.zoomAt(state.camera.zoom * Math.exp(-event.deltaY * factor * .01), { x: event.clientX, y: event.clientY });
    } else {
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      this.options.session.setState({ camera: { ...state.camera, x: state.camera.x + dx * factor / state.camera.zoom, y: state.camera.y + dy * factor / state.camera.zoom } });
    }
  };
  private zoomAt(zoom: number, client?: Point): void {
    if (!Number.isFinite(zoom)) return;
    const state = this.options.session.getState(), next = clampZoom(zoom);
    const bounds = this.options.canvas.getBoundingClientRect();
    const anchor = client ?? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }, world = this.world(anchor);
    this.options.session.setState({ camera: { x: world.x - (world.x - state.camera.x) * state.camera.zoom / next, y: world.y - (world.y - state.camera.y) * state.camera.zoom / next, zoom: next } });
  }
  setZoom(zoom: number): void { this.cancelGesture(); this.zoomAt(zoom); }
  zoomToFit(): void {
    this.cancelGesture(); const elements = [...this.hitIndex.elements.values()]; if (!elements.length) { this.options.session.setState({ camera: { x: 0, y: 0, zoom: 1 } }); return; }
    const b = contentBounds(elements), view = this.options.canvas.getBoundingClientRect();
    this.options.session.setState({ camera: { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom: clampZoom(Math.min((view.width - 160) / Math.max(1, b.w), (view.height - 160) / Math.max(1, b.h), 1)) } });
  }
  undo(): void { if (!this.options.isReadOnly()) { this.cancelGesture(); this.options.board.undoManager.undo(); } }
  redo(): void { if (!this.options.isReadOnly()) { this.cancelGesture(); this.options.board.undoManager.redo(); } }
  deleteSelection(): void { if (!this.options.isReadOnly()) { this.cancelGesture(); this.options.board.delete(this.options.session.getState().selectedIds); this.select([]); } }
  duplicateSelection(): void { if (!this.options.isReadOnly()) { this.cancelGesture(); this.select(this.options.board.duplicate(this.options.session.getState().selectedIds)); } }
  reorder(direction: 'forward' | 'backward' | 'front' | 'back'): void {
    if (this.options.isReadOnly()) return; this.cancelGesture();
    const selected = this.selected().sort(compareElements);
    if (direction === 'forward' || direction === 'back') selected.reverse();
    this.options.board.transact(() => { for (const element of selected) this.options.board.reorder(element.id, direction); });
  }
  private keyDown = (event: KeyboardEvent): void => {
    if (interactiveTarget(event.target) || event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
    if (event.code === 'Space') { event.preventDefault(); this.space = true; this.updateCursor(); return; }
    if (key === 'escape') { event.preventDefault(); if (this.gesture || this.touches.size) this.cancelGesture(); else { this.select([]); this.options.session.setState({ tool: 'select' }); } return; }
    if (modifier && event.code === 'KeyZ') { event.preventDefault(); if (event.shiftKey) this.redo(); else this.undo(); return; }
    if (modifier && event.code === 'KeyY') { event.preventDefault(); this.redo(); return; }
    if (modifier && event.code === 'KeyD') { event.preventDefault(); this.duplicateSelection(); return; }
    if (modifier && event.code === 'KeyA') { event.preventDefault(); this.select([...this.hitIndex.elements.keys()]); return; }
    if (key === 'backspace' || key === 'delete') { event.preventDefault(); this.deleteSelection(); return; }
    if (event.code === 'BracketLeft' || event.code === 'BracketRight') { event.preventDefault(); this.reorder(event.code === 'BracketRight' ? event.shiftKey ? 'front' : 'forward' : event.shiftKey ? 'back' : 'backward'); return; }
    if (key.startsWith('arrow') && !this.options.isReadOnly()) {
      const delta = event.shiftKey ? 10 : 1;
      const movement: Record<string, Point> = { arrowleft: { x: -delta, y: 0 }, arrowright: { x: delta, y: 0 }, arrowup: { x: 0, y: -delta }, arrowdown: { x: 0, y: delta } };
      if (movement[key]) { event.preventDefault(); this.cancelGesture(); this.options.board.move(this.options.session.getState().selectedIds, movement[key]!); } return;
    }
    if (!modifier && !event.altKey && !this.options.isReadOnly()) {
      const shortcuts: Record<string, Tool> = { KeyV: 'select', KeyR: 'rect', KeyO: 'ellipse', KeyN: 'sticky', KeyH: 'pan', KeyP: 'draw', KeyE: 'eraser', KeyT: 'text', KeyC: 'connector' };
      if (shortcuts[event.code]) { event.preventDefault(); this.options.session.setState({ tool: shortcuts[event.code] }); }
    }
  };
  private keyUp = (event: KeyboardEvent): void => { if (event.code === 'Space') { this.space = false; this.updateCursor(); } };
  private updateCursor(point?: Point): void {
    const tool = this.options.session.getState().tool;
    let cursor = this.pinch || this.gesture?.kind === 'pan' ? 'grabbing' : this.space || tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    const handle = point && tool === 'select' && !this.gesture ? this.handleAt(point) : null;
    if (handle) cursor = handle === 'rotate' ? 'crosshair' : ['nw', 'se'].includes(handle) ? 'nwse-resize' : ['ne', 'sw'].includes(handle) ? 'nesw-resize' : ['n', 's'].includes(handle) ? 'ns-resize' : 'ew-resize';
    else if (this.gesture?.kind === 'move') cursor = 'move';
    this.options.canvas.style.cursor = cursor;
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true; this.cancelGesture(); this.unsubscribeBoard(); this.unsubscribeSession();
    const canvas = this.options.canvas; canvas.style.touchAction = this.previousTouchAction;
    canvas.removeEventListener('pointerdown', this.pointerDown); canvas.removeEventListener('pointermove', this.pointerMove); canvas.removeEventListener('pointerup', this.pointerUp);
    canvas.removeEventListener('pointercancel', this.pointerCancel); canvas.removeEventListener('lostpointercapture', this.pointerCancel); canvas.removeEventListener('dblclick', this.doubleClick); canvas.removeEventListener('wheel', this.wheel);
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.blur);
    this.options.renderer.setSelection({});
  }
}

function translateElement(element: Element, delta: Point): Element {
  if (element.type === 'stroke') return { ...element, x: element.x + delta.x, y: element.y + delta.y, props: { ...element.props, points: element.props.points.map((value, i) => value + (i % 3 === 0 ? delta.x : i % 3 === 1 ? delta.y : 0)) } };
  if (element.type === 'connector') {
    const translate = (binding: Binding): Binding => {
      if ('elementId' in binding) return binding;
      return { x: binding.x + delta.x, y: binding.y + delta.y };
    };
    return { ...element, props: { ...element.props, start: translate(element.props.start), end: translate(element.props.end) } };
  }
  return { ...element, x: element.x + delta.x, y: element.y + delta.y };
}

export interface SelectionTransform {
  frame: SelectionFrame; handle: SelectionHandle; initial: ReadonlyMap<string, Element>; ids: string[];
  start: Point; point: Point; shift: boolean;
  elements?: ReadonlyMap<string, Element>;
}
export function transformElement(element: Element, gesture: SelectionTransform): Element {
  const frame = gesture.frame, center = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  if (gesture.handle === 'rotate') {
    let angle = Math.atan2(gesture.point.y - center.y, gesture.point.x - center.x) - Math.atan2(gesture.start.y - center.y, gesture.start.x - center.x);
    if (gesture.shift) angle = Math.round((frame.rotation + angle) / (Math.PI / 12)) * Math.PI / 12 - frame.rotation;
    const initial = gesture.initial.get(element.id)!;
    const initialCenter = { x: initial.x + initial.w / 2, y: initial.y + initial.h / 2 };
    const p = rotatePoint(initialCenter, center, angle);
    if (element.type === 'stroke') return deriveElementGeometry({ ...element, rotation: element.rotation + angle, props: { ...element.props,
      points: element.props.points.map((value, i) => value + (i % 3 === 0 ? p.x - initialCenter.x : i % 3 === 1 ? p.y - initialCenter.y : 0)) } });
    if (element.type === 'connector') return transformConnector(element, gesture, point => rotatePoint(point, center, angle));
    return { ...element, x: element.x + p.x - initialCenter.x, y: element.y + p.y - initialCenter.y, rotation: element.rotation + angle };
  }
  const start = rotatePoint(gesture.start, center, -frame.rotation), end = rotatePoint(gesture.point, center, -frame.rotation);
  const dx = end.x - start.x, dy = end.y - start.y, west = gesture.handle.includes('w'), east = gesture.handle.includes('e'), north = gesture.handle.includes('n'), south = gesture.handle.includes('s');
  let w = Math.max(1, frame.w + (east ? dx : west ? -dx : 0)), h = Math.max(1, frame.h + (south ? dy : north ? -dy : 0));
  if (gesture.shift && (east || west) && (north || south)) { const scale = Math.max(w / Math.max(1, frame.w), h / Math.max(1, frame.h)); w = frame.w * scale; h = frame.h * scale; }
  const localCenter = { x: center.x + (west ? -(w - frame.w) : east ? w - frame.w : 0) / 2, y: center.y + (north ? -(h - frame.h) : south ? h - frame.h : 0) / 2 };
  const nextCenter = rotatePoint(localCenter, center, frame.rotation), initial = gesture.initial.get(element.id)!;
  const sx = w / Math.max(1, frame.w), sy = h / Math.max(1, frame.h);
  const mapPoint = (point: Point): Point => {
    const local = rotatePoint(point, center, -frame.rotation);
    return rotatePoint({ x: nextCenter.x + (local.x - center.x) * sx, y: nextCenter.y + (local.y - center.y) * sy }, nextCenter, frame.rotation);
  };
  if (element.type === 'stroke') {
    const strokeCenter = { x: element.x + element.w / 2, y: element.y + element.h / 2 }, points: number[] = [];
    for (let i = 0; i < element.props.points.length; i += 3) {
      const point = mapPoint(rotatePoint({ x: element.props.points[i]!, y: element.props.points[i + 1]! }, strokeCenter, element.rotation));
      points.push(point.x, point.y, element.props.points[i + 2]!);
    }
    return deriveElementGeometry({ ...element, rotation: 0, props: { ...element.props, points } });
  }
  if (element.type === 'connector') return transformConnector(element, gesture, mapPoint);
  const textProps = element.type === 'text' ? { props: { ...element.props, autoSize: false } } : {};
  if (gesture.ids.length === 1) return { ...element, ...textProps, x: element.x + nextCenter.x - center.x - (w - frame.w) / 2, y: element.y + nextCenter.y - center.y - (h - frame.h) / 2, w: Math.max(1, element.w + w - frame.w), h: Math.max(1, element.h + h - frame.h) } as Element;
  const oldCenter = { x: initial.x + initial.w / 2, y: initial.y + initial.h / 2 };
  const targetCenter = { x: nextCenter.x + (oldCenter.x - center.x) * sx, y: nextCenter.y + (oldCenter.y - center.y) * sy };
  const nextW = Math.max(1, element.w + initial.w * (sx - 1)), nextH = Math.max(1, element.h + initial.h * (sy - 1));
  return { ...element, ...textProps, x: element.x + targetCenter.x - oldCenter.x - (nextW - element.w) / 2, y: element.y + targetCenter.y - oldCenter.y - (nextH - element.h) / 2, w: nextW, h: nextH } as Element;
}

function transformConnector(element: ElementOf<'connector'>, transform: SelectionTransform, mapPoint: (point: Point) => Point): ElementOf<'connector'> {
  const transformBinding = (binding: Binding): Binding => {
    if ('elementId' in binding && transform.ids.includes(binding.elementId)) return binding;
    return mapPoint(resolveBinding(binding, transform.elements ?? transform.initial));
  };
  return { ...element, props: { ...element.props, start: transformBinding(element.props.start), end: transformBinding(element.props.end) } };
}
