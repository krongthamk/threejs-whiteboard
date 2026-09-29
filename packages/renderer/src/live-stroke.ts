import * as THREE from 'three';
import { strokeOutline, type ElementOf } from '@whiteboard/model';
import { cssColor } from './shapes';

/** The active pen stroke never enters the committed stroke chunks. */
export class LiveStroke {
  private geometry = new THREE.BufferGeometry();
  private material = new THREE.MeshBasicMaterial({ color: cssColor('#334155'), side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false });
  readonly mesh = new THREE.Mesh(this.geometry, this.material);
  private capacity = 0;
  constructor() { this.mesh.visible = false; this.mesh.renderOrder = 12000; this.mesh.frustumCulled = false; }
  set(element: ElementOf<'stroke'> | null): void {
    this.mesh.visible = !!element;
    if (!element) { this.geometry.setDrawRange(0, 0); return; }
    const outline = strokeOutline(element), vertices = outline.map(p => new THREE.Vector2(p.x, -p.y));
    const triangles = THREE.ShapeUtils.triangulateShape(vertices, []), size = triangles.length * 9;
    if (size > this.capacity) {
      this.capacity = Math.max(96, 2 ** Math.ceil(Math.log2(size)));
      this.geometry.dispose(); this.geometry = new THREE.BufferGeometry(); this.mesh.geometry = this.geometry;
      this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity), 3).setUsage(THREE.DynamicDrawUsage));
    }
    const positions = this.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (positions) {
      let offset = 0;
      for (const triangle of triangles) for (const index of triangle) { const p = vertices[index]!; positions.setXYZ(offset++, p.x, p.y, 150); }
      positions.clearUpdateRanges(); positions.addUpdateRange(0, size); positions.needsUpdate = true;
      this.geometry.setDrawRange(0, triangles.length * 3);
    }
    this.material.color.copy(cssColor(element.style.stroke)); this.material.opacity = element.style.opacity;
  }
  dispose(): void { this.mesh.removeFromParent(); this.geometry.dispose(); this.material.dispose(); }
}
