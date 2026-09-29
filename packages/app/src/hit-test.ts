import RBush from 'rbush';
import { compareElements, contentBounds, distanceToSegment, getElementBounds, hitTestElement, strokeOutline, type Box, type Element, type Point } from '@whiteboard/model';
import type { SelectionFrame } from '@whiteboard/renderer';

interface Entry { id: string; minX: number; minY: number; maxX: number; maxY: number }
const entry = (id: string, b: Box): Entry => ({ id, minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h });

/** Document-owned geometry, broad-phase R-tree, then shared precise model tests. */
export class HitIndex {
  readonly elements = new Map<string, Element>();
  private tree = new RBush<Entry>();
  private entries = new Map<string, Entry>();
  private dependents = new Map<string, Set<string>>();

  constructor(elements: readonly Element[] = []) { this.reset(elements); }
  reset(elements: readonly Element[]): void {
    this.elements.clear(); this.entries.clear(); this.dependents.clear(); this.tree.clear();
    for (const element of elements) { this.elements.set(element.id, element); this.addDependencies(element); }
    const entries = elements.map(element => entry(element.id, getElementBounds(element, this.elements)));
    for (const value of entries) this.entries.set(value.id, value);
    this.tree.load(entries);
  }
  private addDependencies(element: Element): void {
    if (element.type !== 'connector') return;
    for (const binding of [element.props.start, element.props.end]) if ('elementId' in binding) {
      const ids = this.dependents.get(binding.elementId) ?? new Set<string>(); ids.add(element.id); this.dependents.set(binding.elementId, ids);
    }
  }
  private removeDependencies(element: Element | undefined): void {
    if (element?.type !== 'connector') return;
    for (const binding of [element.props.start, element.props.end]) if ('elementId' in binding) {
      const ids = this.dependents.get(binding.elementId); ids?.delete(element.id); if (!ids?.size) this.dependents.delete(binding.elementId);
    }
  }
  apply(upserts: readonly Element[], removals: readonly string[] = []): void {
    const changed = new Set([...upserts.map(e => e.id), ...removals]);
    for (const id of [...changed]) for (const dependent of this.dependents.get(id) ?? []) changed.add(dependent);
    for (const element of upserts) { this.removeDependencies(this.elements.get(element.id)); this.elements.set(element.id, element); this.addDependencies(element); }
    for (const id of removals) { this.removeDependencies(this.elements.get(id)); this.elements.delete(id); }
    for (const id of changed) {
      const previous = this.entries.get(id); if (previous) this.tree.remove(previous);
      this.entries.delete(id);
      const element = this.elements.get(id);
      if (element) { const value = entry(id, getElementBounds(element, this.elements)); this.entries.set(id, value); this.tree.insert(value); }
    }
  }
  hit(point: Point, tolerance = 3): Element | undefined {
    return this.tree.search(entry('', { x: point.x - tolerance, y: point.y - tolerance, w: tolerance * 2, h: tolerance * 2 }))
      .map(item => this.elements.get(item.id)!).sort((a, b) => compareElements(b, a))
      .find(element => hitTestElement(element, point, tolerance + (element.type === 'stroke' || element.type === 'connector' ? 0 : element.style.strokeWidth / 2), this.elements));
  }
  /** Marquee selects fully contained rendered bounds; rotated corners cannot leak in. */
  within(bounds: Box): Element[] {
    return this.tree.search(entry('', bounds)).filter(b => b.minX >= bounds.x && b.minY >= bounds.y && b.maxX <= bounds.x + bounds.w && b.maxY <= bounds.y + bounds.h)
      .map(item => this.elements.get(item.id)!).sort(compareElements);
  }
  /** Sweep the eraser segment, so a fast pointer cannot jump over a thin stroke. */
  strokesAlong(a: Point, b: Point, radius: number): Element[] {
    const candidates = this.tree.search({ minX: Math.min(a.x, b.x) - radius, minY: Math.min(a.y, b.y) - radius, maxX: Math.max(a.x, b.x) + radius, maxY: Math.max(a.y, b.y) + radius });
    return candidates.map(value => this.elements.get(value.id)!).filter(element => {
      if (element.type !== 'stroke') return false;
      if (hitTestElement(element, a, radius) || hitTestElement(element, b, radius)) return true;
      const outline = strokeOutline(element);
      return outline.some((c, i) => {
        const d = outline[(i + 1) % outline.length]!;
        const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        const intersects = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
        return intersects || Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b)) <= radius;
      });
    });
  }
}

export function selectionFrame(elements: readonly Element[], allElements: ReadonlyMap<string, Element> = new Map(elements.map(element => [element.id, element]))): SelectionFrame | null {
  if (!elements.length) return null;
  const element = elements[0]!;
  if (elements.length === 1 && element.type !== 'connector' && element.type !== 'stroke') return { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation };
  const boxes = elements.map(element => getElementBounds(element, allElements));
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, w: Math.max(...boxes.map(box => box.x + box.w)) - x, h: Math.max(...boxes.map(box => box.y + box.h)) - y, rotation: 0 };
}
