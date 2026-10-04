import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { deriveElementGeometry } from './geometry.js';
import { DEFAULT_STYLE, type Binding, type Element, type ElementInput, type ElementOf, type ElementType, type PropsByType } from './types.js';

const TYPES: readonly string[] = ['rect', 'ellipse', 'sticky', 'text', 'stroke', 'connector', 'image'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const MAX_COORDINATE = 1e9;
export const MAX_FONT_SIZE = 1024;
/** UTF-16 units, matching native selection offsets and the model's caret maps. */
export const MAX_TEXT_LENGTH = 50_000;
const coordinate = (v: unknown): v is number => finite(v) && Math.abs(v) <= MAX_COORDINATE;
/** Surrogate pairs are accepted; unpaired UTF-16 code units cannot round-trip through Yjs. */
export const isWellFormedString = (value: unknown): value is string => typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (message: string): never => { throw new Error(`Invalid whiteboard element: ${message}`); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value === 'string') { if (!isWellFormedString(value)) fail('strings must contain well-formed UTF-16'); return; }
  if (value === null || typeof value === 'boolean' || finite(value)) return;
  if (typeof value !== 'object' || !value || ancestors.has(value)) fail('values must be finite, acyclic JSON');
  const object = value as object;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('values must be plain JSON objects');
  ancestors.add(object);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) assertJson(value[i], ancestors); }
  else { for (const [key, item] of Object.entries(object)) { assertJson(key, ancestors); assertJson(item, ancestors); } }
  ancestors.delete(object);
}

export function isBinding(value: unknown): value is Binding {
  if (!record(value)) return false;
  if ('elementId' in value) return nonempty(value.elementId) && finite(value.nx) && value.nx >= 0 && value.nx <= 1 && finite(value.ny) && value.ny >= 0 && value.ny <= 1 && record(value.fallback) && coordinate(value.fallback.x) && coordinate(value.fallback.y);
  return coordinate(value.x) && coordinate(value.y);
}

/** Validate raw state rather than silently hiding semantically invalid CRDT data. */
export function assertValidElement(value: unknown): asserts value is Element {
  assertJson(value);
  if (!record(value)) fail('not an object');
  const e = value as Record<string, unknown>;
  if (!nonempty(e.id) || !TYPES.includes(String(e.type))) fail('id or type');
  if (![e.x, e.y, e.w, e.h].every(coordinate) || !finite(e.rotation) || (e.w as number) < 0 || (e.h as number) < 0) fail(`${e.id}: geometry`);
  if (!nonempty(e.index)) fail(`${e.id}: index`);
  try { generateKeyBetween(e.index as string, null); } catch { fail(`${e.id}: fractional index`); }
  if (!record(e.style)) fail(`${e.id}: style`);
  const style = e.style as Record<string, unknown>;
  if (!['fill', 'stroke', 'color', 'fontFamily'].every(key => typeof style[key] === 'string') ||
    !coordinate(style.strokeWidth) || style.strokeWidth < 0 || !finite(style.opacity) || style.opacity < 0 || style.opacity > 1 || !finite(style.fontSize) || style.fontSize <= 0 || style.fontSize > MAX_FONT_SIZE) fail(`${e.id}: style values`);
  if (!record(e.props)) fail(`${e.id}: props`);
  const props = e.props as Record<string, unknown>;
  const shapeText = (e.type === 'rect' || e.type === 'ellipse') && Object.keys(props).length !== 0;
  if (e.type === 'text' || e.type === 'sticky' || shapeText) {
    if (typeof props.text !== 'string' || !['left', 'center', 'right'].includes(String(props.align)) || typeof props.autoSize !== 'boolean') fail(`${e.id}: text coherence`);
    if ((props.text as string).length > MAX_TEXT_LENGTH) fail(`${e.id}: text exceeds the 50,000 character limit`);
    if (shapeText && (props.autoSize !== false || typeof props.align !== 'string' || typeof props.verticalAlign !== 'string' || !['top', 'middle', 'bottom'].includes(props.verticalAlign))) fail(`${e.id}: shape text coherence`);
  } else if (e.type === 'stroke') {
    if (!Array.isArray(props.points) || props.points.length < 3 || props.points.length % 3 !== 0 || typeof props.simplified !== 'boolean') fail(`${e.id}: stroke coherence`);
    for (let i = 0; i < (props.points as unknown[]).length; i++) {
      const n = (props.points as unknown[])[i];
      if (!finite(n) || (i % 3 === 2 ? n < 0 || n > 1 : Math.abs(n) > MAX_COORDINATE)) fail(`${e.id}: stroke point ${i}`);
    }
  } else if (e.type === 'connector') {
    if (!isBinding(props.start) || !isBinding(props.end) || !['straight', 'elbow', 'curve'].includes(String(props.kind))) fail(`${e.id}: connector coherence`);
  } else if (e.type === 'image') {
    if (!nonempty(props.assetId) || !finite(props.naturalW) || props.naturalW <= 0 || !finite(props.naturalH) || props.naturalH <= 0) fail(`${e.id}: image coherence`);
  } else if (Object.keys(props).length !== 0) fail(`${e.id}: shape props must be empty`);
}

export function createElement<T extends ElementType>(type: T, input: ElementInput<T> = {}): ElementOf<T> {
  const defaults: PropsByType = {
    rect: {}, ellipse: {}, sticky: { text: '', align: 'left', autoSize: false }, text: { text: '', align: 'left', autoSize: true },
    stroke: { points: [input.x ?? 0, input.y ?? 0, 0.5], simplified: false },
    connector: { start: { x: input.x ?? 0, y: input.y ?? 0 }, end: { x: (input.x ?? 0) + 100, y: (input.y ?? 0) + 100 }, kind: 'straight' },
    image: { assetId: 'unassigned', naturalW: 100, naturalH: 100 },
  };
  const element = {
    id: input.id ?? crypto.randomUUID(), type, x: input.x ?? 0, y: input.y ?? 0, w: input.w ?? (type === 'sticky' ? 200 : 160), h: input.h ?? (type === 'sticky' ? 160 : 100),
    rotation: input.rotation ?? 0, index: input.index ?? generateKeyBetween(null, null),
    style: { ...DEFAULT_STYLE, ...(type === 'sticky' ? { fill: '#fff0a8' } : {}), ...input.style },
    props: structuredClone(input.props ?? defaults[type]),
  };
  assertValidElement(element);
  const derived = deriveElementGeometry(element);
  assertValidElement(derived);
  return derived as ElementOf<T>;
}

export function elementToYMap(element: Element): Y.Map<unknown> {
  assertValidElement(element);
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(element)) map.set(key, structuredClone(value));
  return map;
}

export function readElement(map: Y.Map<unknown>): Element {
  // Plain JSON values are held by reference in Yjs: never expose them for untracked mutation.
  const value = structuredClone(map.toJSON());
  assertValidElement(value);
  const derived = deriveElementGeometry(value);
  assertValidElement(derived);
  return derived;
}

export function compareElements(a: Element, b: Element): number {
  return a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function readElements(elements: Y.Map<Y.Map<unknown>>): Element[] {
  return Array.from(elements.entries(), ([id, map]) => {
    if (!(map instanceof Y.Map)) fail(`${id}: expected nested Y.Map`);
    const element = readElement(map);
    if (element.id !== id) fail(`${id}: key does not match element id`);
    return element;
  }).sort(compareElements);
}
