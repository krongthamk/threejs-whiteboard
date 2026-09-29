import { describe, expect, it } from 'vitest';
import { bindToElement, createElement, rotatePoint } from '../../model/src/index';
import { transformElement, type SelectionTransform } from '../src/controller';
import { selectionFrame } from '../src/hit-test';

describe('selection transformations', () => {
  it('resizes a rotated shape around the opposite corner', () => {
    const element = createElement('rect', { x: 50, y: 100, w: 200, h: 80, rotation: Math.PI / 3 });
    const center = { x: 150, y: 140 }, start = rotatePoint({ x: 250, y: 180 }, center, element.rotation);
    const point = rotatePoint({ x: 280, y: 200 }, center, element.rotation);
    const transform: SelectionTransform = { frame: selectionFrame([element])!, initial: new Map([[element.id, element]]), ids: [element.id], handle: 'se', start, point, shift: false };
    const result = transformElement(element, transform);
    expect(result.w).toBeCloseTo(230); expect(result.h).toBeCloseTo(100);
    const anchor = rotatePoint({ x: element.x, y: element.y }, center, element.rotation);
    const nextAnchor = rotatePoint({ x: result.x, y: result.y }, { x: result.x + result.w / 2, y: result.y + result.h / 2 }, result.rotation);
    expect(nextAnchor.x).toBeCloseTo(anchor.x); expect(nextAnchor.y).toBeCloseTo(anchor.y);
  });
  it('applies a resize delta to latest peer geometry while preserving peer style', () => {
    const initial = createElement('ellipse', { x: 0, y: 0, w: 100, h: 50 });
    const latest = { ...initial, x: 25, y: 35, w: 120, style: { ...initial.style, fill: '#ff0000' } };
    const result = transformElement(latest, { frame: selectionFrame([initial])!, initial: new Map([[initial.id, initial]]), ids: [initial.id], handle: 'se', start: { x: 100, y: 50 }, point: { x: 140, y: 70 }, shift: false });
    expect(result).toMatchObject({ x: 25, y: 35, w: 160, h: 70, style: { fill: '#ff0000' } });
  });
  it('preserves a peer translation when rotating an individual element', () => {
    const initial = createElement('rect', { x: 0, y: 0, w: 100, h: 50 });
    const latest = { ...initial, x: 30, y: 10 };
    const result = transformElement(latest, { frame: selectionFrame([initial])!, initial: new Map([[initial.id, initial]]), ids: [initial.id], handle: 'rotate', start: { x: 50, y: -25 }, point: { x: 100, y: 25 }, shift: false });
    expect(result.x).toBe(30); expect(result.y).toBe(10); expect(result.rotation).toBeCloseTo(Math.PI / 2);
  });
  it('clamps dimensions when dragging across the fixed opposite corner', () => {
    const initial = createElement('rect', { x: 0, y: 0, w: 100, h: 50 });
    const result = transformElement(initial, { frame: selectionFrame([initial])!, initial: new Map([[initial.id, initial]]), ids: [initial.id], handle: 'nw', start: { x: 0, y: 0 }, point: { x: 200, y: 100 }, shift: false });
    expect(result.w).toBe(1); expect(result.h).toBe(1); expect(result.x + result.w).toBe(100); expect(result.y + result.h).toBe(50);
  });
  it('resizes stroke coordinates and retains pressure rather than changing ignored width fields', () => {
    const initial = createElement('stroke', { props: { points: [0, 0, .2, 50, 50, .9, 100, 100, .3], simplified: true } });
    const result = transformElement(initial, { frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 }, initial: new Map([[initial.id, initial]]), ids: [initial.id], handle: 'se', start: { x: 100, y: 100 }, point: { x: 200, y: 150 }, shift: false });
    if (result.type !== 'stroke') throw new Error('Expected stroke');
    expect(result.props.points).toEqual([0, 0, .2, 100, 75, .9, 200, 150, .3]);
    expect(result.w).toBe(200); expect(result.h).toBe(150);
  });
  it('keeps bindings to targets transformed in the same selection', () => {
    const target = createElement('rect', { x: 100, y: 0, w: 100, h: 100 });
    const connector = createElement('connector', { props: { start: { x: 0, y: 50 }, end: bindToElement(target, 0, .5), kind: 'straight' } });
    const elements = new Map([target, connector].map(element => [element.id, element]));
    const result = transformElement(connector, { frame: { x: 0, y: 0, w: 200, h: 100, rotation: 0 }, initial: elements, elements, ids: [target.id, connector.id], handle: 'se', start: { x: 200, y: 100 }, point: { x: 400, y: 200 }, shift: false });
    if (result.type !== 'connector') throw new Error('Expected connector');
    expect(result.props.start).toEqual({ x: 0, y: 100 }); expect(result.props.end).toEqual(connector.props.end);
  });
  it('makes an auto-sized text box fixed width when resizing', () => {
    const text = createElement('text', { props: { text: 'A text label', autoSize: true, align: 'left' } });
    const result = transformElement(text, { frame: selectionFrame([text])!, initial: new Map([[text.id, text]]), ids: [text.id], handle: 'e', start: { x: text.w, y: text.h / 2 }, point: { x: text.w + 100, y: text.h / 2 }, shift: false });
    expect(result.props).toMatchObject({ text: 'A text label', autoSize: false }); expect(result.w).toBeCloseTo(text.w + 100);
  });
});
