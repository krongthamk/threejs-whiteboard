import * as THREE from 'three';
import { STICKY_CORNER_RADIUS } from '@whiteboard/model';
import type { RenderElement } from './types';

const color = new THREE.Color();
/** Unlit 2D colors deliberately composite in CSS/sRGB component space, as SVG does. */
export function cssColor(value: string): THREE.Color {
  return new THREE.Color().setStyle(value, THREE.LinearSRGBColorSpace);
}
export function rgba(value: string, opacity: number): [number, number, number, number] {
  if (value === 'none' || value === 'transparent') return [0, 0, 0, 0];
  color.setStyle(value, THREE.LinearSRGBColorSpace);
  return [color.r, color.g, color.b, opacity];
}

const vertexShader = /* glsl */ `
  attribute vec4 fillColor;
  attribute vec4 borderColor;
  attribute vec4 shapeSize;
  varying vec2 local;
  varying vec4 fill;
  varying vec4 border;
  varying vec4 size;
  void main() {
    local = position.xy;
    fill = fillColor; border = borderColor; size = shapeSize;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = /* glsl */ `
  uniform float ellipse;
  varying vec2 local;
  varying vec4 fill;
  varying vec4 border;
  varying vec4 size;
  void main() {
    vec2 halfSize = size.xy * 0.5;
    vec2 p = local * (size.xy + size.z);
    float radius = min(size.w, min(halfSize.x, halfSize.y));
    vec2 q = abs(p) - halfSize + radius;
    float rectDistance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    float ellipseDistance = (length(p / halfSize) - 1.0) * min(halfSize.x, halfSize.y);
    float d = mix(rectDistance, ellipseDistance, ellipse);
    float aa = max(fwidth(d), 0.01);
    float coverage = 1.0 - smoothstep(size.z * .5 - aa * .5, size.z * .5 + aa * .5, d);
    float borderCoverage = size.z > 0.0 ? smoothstep(-size.z * .5 - aa * .5, -size.z * .5 + aa * .5, d) : 0.0;
    vec4 c = mix(fill, border, borderCoverage);
    if (c.a * coverage < 0.001) discard;
    gl_FragColor = vec4(c.rgb, c.a * coverage);
    #include <colorspace_fragment>
  }
`;

export function createShapeBatch(elements: readonly RenderElement[], depths: Map<string, number>): THREE.InstancedMesh {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const fills = new Float32Array(elements.length * 4);
  const borders = new Float32Array(elements.length * 4);
  const sizes = new Float32Array(elements.length * 4);
  const material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: { ellipse: { value: elements[0]?.type === 'ellipse' ? 1 : 0 } },
    transparent: elements.some(element => element.style.opacity < 1),
    alphaToCoverage: elements.every(element => element.style.opacity === 1),
    depthTest: true, depthWrite: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, elements.length);
  geometry.setAttribute('fillColor', new THREE.InstancedBufferAttribute(fills, 4));
  geometry.setAttribute('borderColor', new THREE.InstancedBufferAttribute(borders, 4));
  geometry.setAttribute('shapeSize', new THREE.InstancedBufferAttribute(sizes, 4));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  elements.forEach((element, index) => updateShapeInstance(mesh, index, element, depths.get(element.id) ?? 0));
  mesh.computeBoundingSphere();
  mesh.renderOrder = material.transparent ? 1000 + (depths.get(elements[0]!.id) ?? 0) : 1;
  return mesh;
}

const transform = new THREE.Object3D();
export function updateShapeInstance(mesh: THREE.InstancedMesh, index: number, element: RenderElement, depth: number): void {
  const { w, h, x, y, style } = element;
  const borderWidth = style.stroke === 'none' || style.stroke === 'transparent' ? 0 : style.strokeWidth;
  transform.position.set(x + w / 2, -(y + h / 2), depth);
  transform.scale.set(Math.max(w + borderWidth, 0.001), Math.max(h + borderWidth, 0.001), 1);
  transform.rotation.z = -element.rotation; transform.updateMatrix(); mesh.setMatrixAt(index, transform.matrix);
  const fills = mesh.geometry.getAttribute('fillColor') as THREE.InstancedBufferAttribute;
  const borders = mesh.geometry.getAttribute('borderColor') as THREE.InstancedBufferAttribute;
  const sizes = mesh.geometry.getAttribute('shapeSize') as THREE.InstancedBufferAttribute;
  fills.setXYZW(index, ...rgba(style.fill, style.opacity));
  borders.setXYZW(index, ...rgba(style.stroke, style.opacity));
  sizes.setXYZW(index, Math.max(w, .001), Math.max(h, .001), borderWidth, element.type === 'sticky' ? STICKY_CORNER_RADIUS : 0);
  for (const attribute of [fills, borders, sizes]) { attribute.addUpdateRange(index * 4, 4); attribute.needsUpdate = true; }
  mesh.instanceMatrix.addUpdateRange(index * 16, 16); mesh.instanceMatrix.needsUpdate = true;
}

export function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  materials.forEach(material => material.dispose());
  mesh.removeFromParent();
}
