import * as THREE from 'three';
import { strokeOutline } from '@whiteboard/model';
import type { RenderElement } from './types';
import { rgba } from './shapes';

export const STROKES_PER_CHUNK = 256;

// Model snapshots are immutable. Cache tessellation, which is independent of depth.
// Repacking a partially filled chunk then costs buffer copies, not earcut for 255 peers.
const tessellations = new WeakMap<RenderElement, { points: THREE.Vector2[]; triangles: number[][] }>();

export function createStrokeChunk(elements: readonly RenderElement[], depths: Map<string, number>): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const element of elements) {
    let cached = tessellations.get(element);
    if (!cached) {
      const outline = strokeOutline(element);
      if (outline.length < 3) continue;
      const points = outline.map(p => new THREE.Vector2(p.x, -p.y));
      cached = { points, triangles: THREE.ShapeUtils.triangulateShape(points, []) };
      tessellations.set(element, cached);
    }
    const { points, triangles } = cached;
    const offset = positions.length / 3;
    const tint = rgba(element.style.stroke, element.style.opacity);
    const depth = depths.get(element.id) ?? 0;
    for (const point of points) {
      positions.push(point.x, point.y, depth);
      colors.push(...tint);
    }
    for (const triangle of triangles) for (const index of triangle) indices.push(index + offset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('tint', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    vertexShader: 'attribute vec4 tint; varying vec4 color; void main(){ color=tint; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'varying vec4 color; void main(){ gl_FragColor=color;\n#include <colorspace_fragment>\n}',
    transparent: elements.some(element => element.style.opacity < 1), depthTest: true, depthWrite: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = material.transparent ? 1000 + (depths.get(elements[0]!.id) ?? 0) : 2;
  return mesh;
}
