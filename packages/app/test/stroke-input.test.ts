import { describe, expect, it } from 'vitest';
import { simplifyStroke } from '../src/stroke-input';

describe('pressure-aware input simplification', () => {
  it('removes redundant collinear points without changing endpoints', () => {
    const points = Array.from({ length: 100 }, (_, i) => [i, i * 2, .5]).flat();
    expect(simplifyStroke(points, .35)).toEqual([0, 0, .5, 99, 198, .5]);
  });
  it('retains pressure extrema even on a geometrically straight stroke', () => {
    const points = [0, 0, .1, 10, 0, .3, 20, 0, .9, 30, 0, .3, 40, 0, .1];
    const result = simplifyStroke(points, 1);
    expect(result).toContain(.9); expect(result.slice(0, 3)).toEqual(points.slice(0, 3)); expect(result.slice(-3)).toEqual(points.slice(-3));
  });
  it('keeps a sharp bend and preserves a one-point tap', () => {
    const points = [0, 0, .5, 10, 0, .5, 20, 0, .5, 20, 10, .5, 20, 20, .5];
    expect(simplifyStroke(points, .35)).toEqual([0, 0, .5, 20, 0, .5, 20, 20, .5]);
    expect(simplifyStroke([1, 2, .8], .35)).toEqual([1, 2, .8]);
  });
});
