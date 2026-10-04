import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { getElementBounds, rotatePoint, type Element, type Point } from '@whiteboard/model';
import { cssColor } from './shapes';
import type { RemotePresence } from './types';
import { syncTextAtlas } from './text-atlas';

interface Label { group: THREE.Group; text: Text; background: THREE.Mesh; value: string; ready: boolean; error: boolean; cancelSync?: () => void; generation: number; disposed: boolean }
interface Peer {
  state: RemotePresence; group: THREE.Group; cursor: THREE.Group; arrow: THREE.Mesh;
  name: Label; editing: Label; frame: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}
const MAX_PEERS = 40;

/** Ephemeral projection: constant primitive count per peer, no document writes. */
export class PresenceProjection {
  private peers = new Map<string, Peer>();
  private elements: ReadonlyMap<string, Element> = new Map();
  private zoom = 1;
  private plane = new THREE.PlaneGeometry(1, 1);
  private cursorGeometry = new THREE.BufferGeometry();
  constructor(private group: THREE.Group, private font: string, private timeoutMs: number, private invalidate: () => void = () => {}) {
    this.cursorGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 4, -17, 0, 8, -11, 0, 0, 0, 0, 8, -11, 0, 16, -10, 0], 3));
  }
  set(presences: readonly RemotePresence[], elements: ReadonlyMap<string, Element>, zoom: number): void {
    this.elements = elements; this.zoom = zoom;
    const retained = new Set<string>();
    for (const state of presences.slice(0, MAX_PEERS)) {
      const id = String(state.clientId); if (retained.has(id)) continue; retained.add(id);
      const safe: RemotePresence = { ...state, name: String(state.name).slice(0, 80), selection: [...state.selection],
        color: /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#4378ed',
        cursor: state.cursor && Number.isFinite(state.cursor.x) && Number.isFinite(state.cursor.y) ? { ...state.cursor } : null };
      let peer = this.peers.get(id);
      if (!peer) { peer = this.create(safe); this.peers.set(id, peer); this.update(peer); continue; }
      const old = peer.state;
      const decorationChanged = old.name !== safe.name || old.color !== safe.color;
      const selectionChanged = old.editingTextId !== safe.editingTextId || old.selection.length !== safe.selection.length || old.selection.some((id, i) => id !== safe.selection[i]);
      peer.state = safe;
      if (decorationChanged) this.update(peer);
      else {
        if (old.cursor?.x !== safe.cursor?.x || old.cursor?.y !== safe.cursor?.y) this.updateCursor(peer);
        if (selectionChanged) this.updateFrames(peer);
      }
    }
    for (const [id, peer] of this.peers) if (!retained.has(id)) { this.remove(peer); this.peers.delete(id); }
  }
  updateDocument(elements: ReadonlyMap<string, Element>): void { this.elements = elements; for (const peer of this.peers.values()) this.updateFrames(peer); }
  setZoom(zoom: number): void { if (zoom === this.zoom) return; this.zoom = zoom; for (const peer of this.peers.values()) this.update(peer); }
  private create(state: RemotePresence): Peer {
    const group = new THREE.Group(), cursor = new THREE.Group(); group.name = `peer:${String(state.clientId)}`;
    const material = () => new THREE.MeshBasicMaterial({ color: cssColor(state.color), transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const arrow = new THREE.Mesh(this.cursorGeometry, material()); arrow.renderOrder = 30001; cursor.add(arrow);
    const frameGeometry = new THREE.BufferGeometry(); frameGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(144), 3).setUsage(THREE.DynamicDrawUsage));
    frameGeometry.setDrawRange(0, 0);
    const frame = new THREE.Mesh(frameGeometry, material()); frame.frustumCulled = false; frame.renderOrder = 30000;
    const name = this.createLabel(), editing = this.createLabel(); cursor.add(name.group); name.group.position.set(15, -14, 0);
    group.add(cursor, frame, editing.group); this.group.add(group);
    return { state, group, cursor, arrow, name, editing, frame };
  }
  private createLabel(): Label {
    const group = new THREE.Group(), text = new Text();
    text.font = this.font; text.fontSize = 11; text.color = cssColor('#ffffff'); text.anchorX = 'left'; text.anchorY = 'top'; text.lineHeight = 1;
    text.position.set(5, -4, .01); text.material.depthTest = false; text.material.depthWrite = false; text.renderOrder = 30003; text.visible = false;
    const background = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({ color: cssColor('#4378ed'), transparent: true, depthTest: false, depthWrite: false }));
    background.renderOrder = 30002; background.visible = false;
    group.add(background, text);
    return { group, text, background, value: '', ready: false, error: false, generation: 0, disposed: false };
  }
  private labelValue(label: Label, value: string, color: string): void {
    (label.background.material as THREE.MeshBasicMaterial).color.copy(cssColor(color));
    if (label.value === value) return;
    label.value = value; label.ready = false; label.error = false; label.text.visible = false; label.background.visible = false;
    label.cancelSync?.(); const generation = ++label.generation;
    label.text.text = value;
    label.cancelSync = syncTextAtlas(label.text, this.timeoutMs, () => {
      if (label.disposed || generation !== label.generation || label.error) return;
      const bounds = label.text.textRenderInfo?.blockBounds;
      const width = Math.max(1, bounds ? bounds[2]! - bounds[0]! : value.length * 7) + 10;
      label.background.scale.set(width, 22, 1); label.background.position.set(width / 2, -11, 0);
      label.ready = true; label.text.visible = label.background.visible = true; this.invalidate();
    }, () => { if (!label.disposed && generation === label.generation) { label.error = true; this.invalidate(); } });
  }
  private update(peer: Peer): void {
    const state = peer.state;
    (peer.arrow.material as THREE.MeshBasicMaterial).color.copy(cssColor(state.color)); peer.frame.material.color.copy(cssColor(state.color));
    this.updateCursor(peer);
    this.labelValue(peer.name, state.name || 'Guest', state.color);
    this.updateFrames(peer);
  }
  private updateCursor(peer: Peer): void {
    peer.cursor.visible = !!peer.state.cursor; peer.cursor.scale.setScalar(1 / this.zoom);
    if (peer.state.cursor) peer.cursor.position.set(peer.state.cursor.x, -peer.state.cursor.y, 450);
  }
  private updateFrames(peer: Peer): void {
    const positions = peer.frame.geometry.getAttribute('position') as THREE.BufferAttribute; let vertex = 0;
    const put = (point: Point) => positions.setXYZ(vertex++, point.x, -point.y, 450);
    const outline = (points: Point[], width: number) => {
      points.forEach((a, i) => {
        const b = points[(i + 1) % points.length]!, length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const dx = -(b.y - a.y) / length * width / 2, dy = (b.x - a.x) / length * width / 2;
        const p = { x: a.x + dx, y: a.y + dy }, q = { x: b.x + dx, y: b.y + dy }, r = { x: b.x - dx, y: b.y - dy }, s = { x: a.x - dx, y: a.y - dy };
        for (const point of [p, q, r, p, r, s]) put(point);
      });
    };
    const selected = peer.state.selection.flatMap(id => { const element = this.elements.get(id); return element ? [element] : []; });
    if (selected.length) {
      if (selected.length === 1 && selected[0]!.type !== 'connector' && selected[0]!.type !== 'stroke') {
        const element = selected[0]!, c = { x: element.x + element.w / 2, y: element.y + element.h / 2 };
        outline([{ x: element.x, y: element.y }, { x: element.x + element.w, y: element.y }, { x: element.x + element.w, y: element.y + element.h }, { x: element.x, y: element.y + element.h }].map(point => rotatePoint(point, c, element.rotation)), 1.5 / this.zoom);
      } else {
        let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
        for (const element of selected) { const box = getElementBounds(element, this.elements); x = Math.min(x, box.x); y = Math.min(y, box.y); right = Math.max(right, box.x + box.w); bottom = Math.max(bottom, box.y + box.h); }
        outline([{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }], 1.5 / this.zoom);
      }
    }
    const editing = peer.state.editingTextId ? this.elements.get(peer.state.editingTextId) : undefined;
    peer.editing.group.visible = !!editing && (editing.type === 'text' || editing.type === 'sticky' || editing.type === 'rect' || editing.type === 'ellipse');
    if (peer.editing.group.visible && editing) {
      const b = getElementBounds(editing, this.elements), pad = 3 / this.zoom;
      outline([{ x: b.x - pad, y: b.y - pad }, { x: b.x + b.w + pad, y: b.y - pad }, { x: b.x + b.w + pad, y: b.y + b.h + pad }, { x: b.x - pad, y: b.y + b.h + pad }], 2 / this.zoom);
      peer.editing.group.position.set(b.x, -b.y + 27 / this.zoom, 450); peer.editing.group.scale.setScalar(1 / this.zoom);
      this.labelValue(peer.editing, `${peer.state.name || 'Guest'} · editing`, peer.state.color);
    }
    positions.clearUpdateRanges(); positions.addUpdateRange(0, vertex * 3); positions.needsUpdate = true; peer.frame.geometry.setDrawRange(0, vertex);
  }
  stats(): { presencePeers: number; presenceLabels: number; pendingPresenceLabels: number; presenceErrors: number } {
    let presenceLabels = 0, pendingPresenceLabels = 0, presenceErrors = 0;
    for (const peer of this.peers.values()) for (const label of [peer.name, peer.editing]) { if (label.value) presenceLabels++; if (label.value && !label.ready && !label.error) pendingPresenceLabels++; if (label.error) presenceErrors++; }
    return { presencePeers: this.peers.size, presenceLabels, pendingPresenceLabels, presenceErrors };
  }
  private remove(peer: Peer): void {
    peer.group.removeFromParent(); peer.frame.geometry.dispose(); peer.frame.material.dispose(); (peer.arrow.material as THREE.Material).dispose();
    for (const label of [peer.name, peer.editing]) { label.disposed = true; label.cancelSync?.(); label.text.dispose(); (label.background.material as THREE.Material).dispose(); }
  }
  clear(): void { for (const peer of this.peers.values()) this.remove(peer); this.peers.clear(); }
  dispose(): void { this.clear(); this.plane.dispose(); this.cursorGeometry.dispose(); }
}
