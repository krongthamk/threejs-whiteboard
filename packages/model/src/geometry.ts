import { getStroke } from 'perfect-freehand';
import type { Binding, Box, Element, Point } from './types.js';
import { textSize } from './text-layout.js';
export { textLines, textSize, STICKY_TEXT_INSET } from './text-layout.js';

export function rotatePoint(point: Point, center: Point, angle: number): Point {
  const c = Math.cos(angle), s = Math.sin(angle), x = point.x - center.x, y = point.y - center.y;
  return { x: center.x + x * c - y * s, y: center.y + x * s + y * c };
}

export function pointsBounds(points: readonly Point[]): Box {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  return { x, y, w: right - x, h: bottom - y };
}

/** Boxes for coherent geometry are derived from its single props value. */
export function deriveElementGeometry(element: Element): Element {
  if (element.type === 'stroke') {
    const points: Point[] = [];
    for (let i = 0; i < element.props.points.length; i += 3) points.push({ x: element.props.points[i]!, y: element.props.points[i + 1]! });
    return { ...element, ...pointsBounds(points) };
  }
  if (element.type === 'text' && element.props.autoSize) return { ...element, ...textSize(element.props.text, element.style.fontSize, element.style.fontFamily) };
  return element;
}

export function resolveBinding(binding: Binding, elements: ReadonlyMap<string, Element>): Point {
  if (!('elementId' in binding)) return { x: binding.x, y: binding.y };
  const target = elements.get(binding.elementId);
  if (!target || target.type === 'connector') return { ...binding.fallback };
  return rotatePoint({ x: target.x + target.w * binding.nx, y: target.y + target.h * binding.ny },
    { x: target.x + target.w / 2, y: target.y + target.h / 2 }, target.rotation);
}

export function bindToElement(element: Element, nx: number, ny: number): Binding {
  if (element.type === 'connector') throw new Error('Connectors cannot bind to other connectors');
  const binding = { elementId: element.id, nx, ny, fallback: { x: 0, y: 0 } };
  binding.fallback = resolveBinding(binding, new Map([[element.id, element]]));
  return binding;
}

export function arrowheadPoints(element: Element, elements: ReadonlyMap<string, Element>): Point[] {
  const points = connectorPoints(element, elements), end = points.at(-1)!, before = points.at(-2)!;
  const dx = end.x - before.x, dy = end.y - before.y, magnitude = Math.hypot(dx, dy);
  if (magnitude === 0) return [];
  const length = Math.max(8, element.style.strokeWidth * 4), halfWidth = length * 0.45;
  const ux = dx / magnitude, uy = dy / magnitude;
  return [end, { x: end.x - ux * length - uy * halfWidth, y: end.y - uy * length + ux * halfWidth },
    { x: end.x - ux * length + uy * halfWidth, y: end.y - uy * length - ux * halfWidth }];
}

export function resolveConnectorEndpoints(element: Element, elements: ReadonlyMap<string, Element>): [Point, Point] {
  if (element.type !== 'connector') throw new Error('Expected connector');
  return [resolveBinding(element.props.start, elements), resolveBinding(element.props.end, elements)];
}

/** A shared path also keeps hit testing, SVG and GPU geometry in agreement. */
export function connectorPoints(element: Element, elements: ReadonlyMap<string, Element>): Point[] {
  const [start, end] = resolveConnectorEndpoints(element, elements);
  if (element.type !== 'connector' || element.props.kind === 'straight') return [start, end];
  const midX = (start.x + end.x) / 2;
  if (element.props.kind === 'elbow') return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
  const result: Point[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t;
    result.push({ x: u ** 3 * start.x + 3 * u * u * t * midX + 3 * u * t * t * midX + t ** 3 * end.x,
      y: u ** 3 * start.y + 3 * u * u * t * start.y + 3 * u * t * t * end.y + t ** 3 * end.y });
  }
  return result;
}

export function strokeOutline(element: Element): Point[] {
  if (element.type !== 'stroke') return [];
  const points: number[][] = [];
  for (let i = 0; i < element.props.points.length; i += 3) points.push(element.props.points.slice(i, i + 3));
  const center = { x: element.x + element.w / 2, y: element.y + element.h / 2 };
  return getStroke(points, { size: element.style.strokeWidth * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true })
    .map(([x, y]) => rotatePoint({ x: x!, y: y! }, center, element.rotation));
}

export function getElementBounds(element: Element, elements: ReadonlyMap<string, Element> = new Map()): Box {
  let box: Box;
  if (element.type === 'connector') box = pointsBounds([...connectorPoints(element, elements), ...arrowheadPoints(element, elements)]);
  else if (element.type === 'stroke') return pointsBounds(strokeOutline(element));
  else {
    const center = { x: element.x + element.w / 2, y: element.y + element.h / 2 };
    box = pointsBounds([{ x: element.x, y: element.y }, { x: element.x + element.w, y: element.y },
      { x: element.x + element.w, y: element.y + element.h }, { x: element.x, y: element.y + element.h }]
      .map(point => rotatePoint(point, center, element.rotation)));
  }
  const inset = element.style.strokeWidth / 2;
  return { x: box.x - inset, y: box.y - inset, w: box.w + inset * 2, h: box.h + inset * 2 };
}

export function contentBounds(elements: readonly Element[]): Box {
  const map = new Map(elements.map(element => [element.id, element]));
  return pointsBounds(elements.flatMap(element => {
    const b = getElementBounds(element, map);
    return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }];
  }));
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function pointInPolygon(point: Point, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function hitTestElement(element: Element, point: Point, tolerance = 3, elements: ReadonlyMap<string, Element> = new Map()): boolean {
  if (element.type === 'connector') {
    const path = connectorPoints(element, elements);
    return pointInPolygon(point, arrowheadPoints(element, elements)) || path.slice(1).some((end, i) => distanceToSegment(point, path[i]!, end) <= tolerance + element.style.strokeWidth / 2);
  }
  if (element.type === 'stroke') {
    const outline = strokeOutline(element);
    return pointInPolygon(point, outline) || outline.some((p, i) => distanceToSegment(point, p, outline[(i + 1) % outline.length]!) <= tolerance);
  }
  const p = rotatePoint(point, { x: element.x + element.w / 2, y: element.y + element.h / 2 }, -element.rotation);
  if (element.type === 'ellipse') {
    const rx = element.w / 2 + tolerance, ry = element.h / 2 + tolerance;
    return ((p.x - element.x - element.w / 2) / rx) ** 2 + ((p.y - element.y - element.h / 2) / ry) ** 2 <= 1;
  }
  return p.x >= element.x - tolerance && p.x <= element.x + element.w + tolerance && p.y >= element.y - tolerance && p.y <= element.y + element.h + tolerance;
}
