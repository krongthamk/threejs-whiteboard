import * as THREE from 'three';
import { rotatePoint, type Point } from '@whiteboard/model';
import { cssColor } from './shapes';
import type { Bounds } from './types';

export interface SelectionFrame extends Bounds { rotation: number }
export type SelectionHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';
export interface SelectionState { outlines?: readonly SelectionFrame[]; frame?: SelectionFrame | null; marquee?: Bounds | null }

/** Same positions drive visible handles and the controller's hit test. */
export function selectionHandles(frame: SelectionFrame, zoom: number): { kind: SelectionHandle; point: Point }[] {
  const center = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  return ([['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1],
    ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5], ['rotate', .5, -28 / zoom / Math.max(frame.h, .001)]] as const)
    .map(([kind, x, y]) => ({ kind, point: rotatePoint({ x: frame.x + frame.w * x, y: frame.y + frame.h * y }, center, frame.rotation) }));
}

/** One tiny transient overlay; never reads or writes the board document. */
export class SelectionOverlay {
  private state: SelectionState = {};
  private zoom = 1;
  constructor(private group: THREE.Group) {}
  set(state: SelectionState, zoom: number): void { this.state = state; this.zoom = zoom; this.rebuild(); }
  setZoom(zoom: number): void { if (zoom !== this.zoom) { this.zoom = zoom; this.rebuild(); } }
  dispose(): void {
    for (const object of [...this.group.children]) {
      const mesh = object as THREE.Mesh; mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
      mesh.removeFromParent();
    }
  }
  private rebuild(): void {
    this.dispose();
    const ink: number[] = [], white: number[] = [], fill: number[] = [], width = 1 / this.zoom;
    const triangle = (out: number[], a: Point, b: Point, c: Point) => out.push(a.x, -a.y, 400, b.x, -b.y, 400, c.x, -c.y, 400);
    const quad = (out: number[], points: Point[]) => { triangle(out, points[0]!, points[1]!, points[2]!); triangle(out, points[0]!, points[2]!, points[3]!); };
    const line = (a: Point, b: Point) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const dx = -(b.y - a.y) / length * width / 2, dy = (b.x - a.x) / length * width / 2;
      quad(ink, [{ x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy }, { x: b.x - dx, y: b.y - dy }, { x: a.x - dx, y: a.y - dy }]);
    };
    const corners = (frame: SelectionFrame) => {
      const c = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
      return [{ x: frame.x, y: frame.y }, { x: frame.x + frame.w, y: frame.y }, { x: frame.x + frame.w, y: frame.y + frame.h }, { x: frame.x, y: frame.y + frame.h }].map(p => rotatePoint(p, c, frame.rotation));
    };
    const outline = (frame: SelectionFrame) => { const points = corners(frame); points.forEach((p, i) => line(p, points[(i + 1) % 4]!)); };
    for (const frame of this.state.outlines ?? []) outline(frame);
    if (this.state.marquee) { const frame = { ...this.state.marquee, rotation: 0 }; quad(fill, corners(frame)); outline(frame); }
    if (this.state.frame) {
      const frame = this.state.frame; outline(frame);
      const handles = selectionHandles(frame, this.zoom);
      line(handles[1]!.point, handles[8]!.point);
      for (const { point, kind } of handles) {
        const size = (kind === 'rotate' ? 8 : 7) / this.zoom;
        const box = { x: point.x - size / 2, y: point.y - size / 2, w: size, h: size, rotation: frame.rotation };
        quad(white, corners(box)); outline(box);
      }
    }
    for (const [positions, color, opacity, order] of [[fill, '#4378ed', .1, 20000], [white, '#ffffff', 1, 20001], [ink, '#4378ed', 1, 20002]] as const) {
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.MeshBasicMaterial({ color: cssColor(color), opacity, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = order; this.group.add(mesh);
    }
  }
}
