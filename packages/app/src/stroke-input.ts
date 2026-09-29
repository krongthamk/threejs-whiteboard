import { distanceToSegment } from '@whiteboard/model';

/** RDP in world coordinates, retaining pressure changes as well as spatial bends. */
export function simplifyStroke(points: readonly number[], tolerance: number): number[] {
  const count = points.length / 3; if (count <= 2) return [...points];
  const retained = new Set([0, count - 1]), pending: [number, number][] = [[0, count - 1]];
  while (pending.length) {
    const [start, end] = pending.pop()!;
    const a = { x: points[start * 3]!, y: points[start * 3 + 1]! }, b = { x: points[end * 3]!, y: points[end * 3 + 1]! };
    const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    let worst = 1, chosen = -1;
    for (let i = start + 1; i < end; i++) {
      const p = { x: points[i * 3]!, y: points[i * 3 + 1]! };
      const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length)) : (i - start) / (end - start);
      const pressure = points[start * 3 + 2]! + (points[end * 3 + 2]! - points[start * 3 + 2]!) * t;
      const score = Math.max(distanceToSegment(p, a, b) / Math.max(.001, tolerance), Math.abs(points[i * 3 + 2]! - pressure) / .04);
      if (score > worst) { worst = score; chosen = i; }
    }
    if (chosen >= 0) { retained.add(chosen); pending.push([start, chosen], [chosen, end]); }
  }
  return [...retained].sort((a, b) => a - b).flatMap(index => points.slice(index * 3, index * 3 + 3));
}
