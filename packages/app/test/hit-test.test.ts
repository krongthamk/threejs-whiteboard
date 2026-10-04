import { describe, expect, it } from 'vitest';
import { bindToElement, createElement, getElementBounds, rotatePoint, textLayout, type Element } from '../../model/src/index';
import { HitIndex, selectionFrame } from '../src/hit-test';

describe('document hit index', () => {
  it('rejects a rotated rectangle AABB corner while accepting its visible interior', () => {
    const rect = createElement('rect', { x: 0, y: 0, w: 100, h: 20, rotation: Math.PI / 4, style: { strokeWidth: 0 } });
    const index = new HitIndex([rect]);
    const bounds = getElementBounds(rect);
    expect(index.hit({ x: bounds.x + 1, y: bounds.y + 1 }, 0)).toBeUndefined();
    expect(index.hit({ x: 50, y: 10 }, 0)?.id).toBe(rect.id);
    expect(index.hit(rotatePoint({ x: 99, y: 10 }, { x: 50, y: 10 }, rect.rotation), 0)?.id).toBe(rect.id);
  });
  it('uses ellipse geometry and includes a centered border', () => {
    const ellipse = createElement('ellipse', { x: 0, y: 0, w: 100, h: 60, style: { strokeWidth: 10 } });
    const index = new HitIndex([ellipse]);
    expect(index.hit({ x: 1, y: 1 }, 0)).toBeUndefined();
    expect(index.hit({ x: 104, y: 30 }, 0)?.id).toBe(ellipse.id);
    expect(index.hit({ x: 107, y: 30 }, 0)).toBeUndefined();
  });
  it('chooses the frontmost element in deterministic fractional-index and id order', () => {
    const a = createElement('rect', { id: 'Z', index: 'a0' }), b = createElement('rect', { id: 'a', index: 'a0' });
    const top = createElement('rect', { id: 'top', index: 'a1' });
    const index = new HitIndex([a, top, b]);
    expect(index.hit({ x: 10, y: 10 })?.id).toBe('top');
    index.apply([], ['top']); expect(index.hit({ x: 10, y: 10 })?.id).toBe('a');
  });
  it('updates geometry after a move and removes deleted entries', () => {
    const rect = createElement('rect', { x: 0, y: 0, w: 100, h: 100 });
    const index = new HitIndex([rect]); index.apply([{ ...rect, x: 500 }]);
    expect(index.hit({ x: 50, y: 50 })).toBeUndefined(); expect(index.hit({ x: 550, y: 50 })?.id).toBe(rect.id);
    index.apply([], [rect.id]); expect(index.hit({ x: 550, y: 50 })).toBeUndefined();
  });
  it('reindexes connectors when only a bound target changes', () => {
    const rect = createElement('rect', { x: 100, y: 0, w: 100, h: 100 });
    const connector = createElement('connector', { props: { start: { x: 0, y: 50 }, end: bindToElement(rect, 0, .5), kind: 'straight' } });
    const index = new HitIndex([rect, connector]);
    expect(index.hit({ x: 300, y: 50 }, 0)).toBeUndefined();
    index.apply([{ ...rect, x: 500 }]);
    expect(index.hit({ x: 300, y: 50 }, 0)?.id).toBe(connector.id);
    index.apply([], [rect.id]); expect(index.hit({ x: 300, y: 50 }, 0)).toBeUndefined();
  });
  it('requires the complete rotated painted bounds inside a marquee', () => {
    const rect = createElement('rect', { x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 4, style: { strokeWidth: 0 } });
    const index = new HitIndex([rect]);
    expect(index.within({ x: 0, y: 0, w: 100, h: 100 })).toEqual([]);
    expect(index.within({ x: -30, y: -30, w: 160, h: 160 })).toEqual([rect]);
  });
  it('uses the actual pressure stroke outline rather than its box', () => {
    const stroke = createElement('stroke', { style: { strokeWidth: 4 }, props: { points: [0, 0, .5, 50, 50, .5, 100, 100, .5], simplified: false } });
    const index = new HitIndex([stroke]);
    expect(index.hit({ x: 50, y: 50 }, 0)?.id).toBe(stroke.id);
    expect(index.hit({ x: 0, y: 95 }, 0)).toBeUndefined();
  });
  it('sweeps fast eraser motions across strokes without erasing shapes', () => {
    const stroke = createElement('stroke', { props: { points: [50, 0, .5, 50, 100, .5], simplified: false } });
    const rect = createElement('rect', { x: 0, y: 0, w: 100, h: 100 });
    const index = new HitIndex([rect, stroke]);
    expect(index.strokesAlong({ x: 0, y: 50 }, { x: 100, y: 50 }, 2).map(e => e.id)).toEqual([stroke.id]);
    expect(index.strokesAlong({ x: 0, y: 150 }, { x: 100, y: 150 }, 2)).toEqual([]);
  });
  it('keeps a single frame rotated and encloses all members of a multiple selection', () => {
    const a = createElement('rect', { x: 0, y: 0, w: 100, h: 60, rotation: Math.PI / 3 });
    expect(selectionFrame([a])).toEqual({ x: 0, y: 0, w: 100, h: 60, rotation: Math.PI / 3 });
    const b = createElement('rect', { x: 250, y: 100, w: 100, h: 60 });
    const frame = selectionFrame([a, b])!;
    for (const element of [a, b]) { const bounds = getElementBounds(element); expect(frame.x).toBeLessThanOrEqual(bounds.x); expect(frame.x + frame.w).toBeGreaterThanOrEqual(bounds.x + bounds.w); }
    expect(selectionFrame([])).toBeNull(); expect(frame.rotation).toBe(0);
  });
  it.each(['rect', 'ellipse'] as const)('keeps %s precise hits, marquee and selection bounds unchanged by an overflowing label', type => {
    const empty = createElement(type, { id: type, x: 30, y: -20, w: 100, h: 40, rotation: Math.PI / 4, style: { strokeWidth: 0 } });
    const labeled = createElement(type, { ...empty,
      props: { text: 'Overflow\n'.repeat(100), align: 'right', autoSize: false, verticalAlign: 'bottom' } });
    expect(textLayout(labeled).verticalOffset).toBeLessThan(-1_000);
    const index = new HitIndex([empty]), center = { x: 80, y: 0 }, bounds = getElementBounds(empty);
    const points = [
      { point: center, hit: true },
      { point: rotatePoint({ x: 125, y: 0 }, center, empty.rotation), hit: true },
      // An ellipse excludes its box corner; the rectangle includes it.
      { point: rotatePoint({ x: 32, y: -18 }, center, empty.rotation), hit: type === 'rect' },
      { point: { x: bounds.x + 1, y: bounds.y + 1 }, hit: false },
      // Unclipped bottom-aligned text would occupy this position above the shape.
      { point: rotatePoint({ x: 80, y: -200 }, center, empty.rotation), hit: false },
    ];
    const singleFrame = selectionFrame([empty]), neighbor = createElement('rect', { x: 300, y: 80, w: 60, h: 40 });
    const multipleFrame = selectionFrame([empty, neighbor]);
    const contained = { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 };
    const incomplete = { x: bounds.x + 1, y: bounds.y, w: bounds.w - 1, h: bounds.h };
    for (const shape of [empty, labeled, empty]) {
      index.apply([shape]);
      for (const { point, hit } of points) expect(index.hit(point, 0)?.id).toBe(hit ? empty.id : undefined);
      expect(index.within(contained).map(element => element.id)).toEqual([empty.id]);
      expect(index.within(incomplete)).toEqual([]);
      expect(getElementBounds(shape)).toEqual(bounds);
      expect(selectionFrame([shape])).toEqual(singleFrame);
      expect(selectionFrame([shape, neighbor])).toEqual(multipleFrame);
    }
  });
});
