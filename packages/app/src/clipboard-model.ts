import { generateKeyBetween } from 'fractional-indexing';
import { assertValidElement, compareElements, contentBounds, deriveElementGeometry, resolveBinding,
  type Binding, type Element, type Point } from '@whiteboard/model';

export const MAX_CLIPBOARD_BYTES = 8 * 1024 * 1024;
export const MAX_CLIPBOARD_ELEMENTS = 10_000;
export interface ClipboardEnvelope {
  type: 'whiteboard/clipboard';
  version: 1;
  sourceBoardId: string;
  elements: Element[];
}
export interface PasteOptions {
  targetBoardId: string;
  center: Point;
  highestIndex: string | null;
  /** One fresh ID per envelope element, in envelope order; the caller owns ID generation. */
  newIds: readonly string[];
  imageAssetIds?: ReadonlyMap<string, string>;
}
function fail(message: string): never { throw new Error(`Invalid whiteboard clipboard: ${message}`); }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function checkBytes(text: string): void {
  if (text.length > MAX_CLIPBOARD_BYTES || new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) fail(`content exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
}
function validateEnvelope(value: unknown): asserts value is ClipboardEnvelope {
  if (!plain(value) || value.type !== 'whiteboard/clipboard' || value.version !== 1) fail('unsupported envelope');
  if (Object.keys(value).sort().join(',') !== 'elements,sourceBoardId,type,version') fail('unknown envelope fields');
  if (!nonempty(value.sourceBoardId) || value.sourceBoardId.length > 200) fail('source board is missing or invalid');
  if (!Array.isArray(value.elements) || value.elements.length === 0 || value.elements.length > MAX_CLIPBOARD_ELEMENTS) fail(`element count must be 1–${MAX_CLIPBOARD_ELEMENTS}`);
  const elements = new Map<string, Element>();
  for (const element of value.elements) {
    try { assertValidElement(element); } catch { fail('an element has invalid geometry, style, or coherent data'); }
    if (elements.has(element.id)) fail('element IDs must be unique');
    elements.set(element.id, element);
  }
  for (const element of elements.values()) if (element.type === 'connector') {
    for (const binding of [element.props.start, element.props.end]) if ('elementId' in binding) {
      const target = elements.get(binding.elementId);
      if (!target || target.type === 'connector') fail('bound endpoints must refer to copied non-connector elements');
    }
  }
}

/** Capture a self-contained selection in z order, including current external endpoints. */
export function encodeClipboard(sourceBoardId: string, selectedIds: readonly string[], allElements: readonly Element[]): string {
  const map = new Map(allElements.map(element => [element.id, deriveElementGeometry(element)]));
  const selected = new Set(selectedIds);
  if (selected.size === 0 || selected.size > MAX_CLIPBOARD_ELEMENTS) fail(`select 1–${MAX_CLIPBOARD_ELEMENTS} elements`);
  const elements = [...selected].map(id => {
    const element = map.get(id); if (!element) fail('a selected element no longer exists');
    assertValidElement(element);
    let copy = structuredClone(element);
    if (copy.type === 'connector') {
      const capture = (binding: Binding): Binding => {
        const point = resolveBinding(binding, map);
        if ('elementId' in binding && selected.has(binding.elementId) && map.get(binding.elementId)?.type !== 'connector') return { ...binding, fallback: point };
        return point;
      };
      copy = { ...copy, props: { ...copy.props, start: capture(copy.props.start), end: capture(copy.props.end) } };
    }
    return copy;
  }).sort(compareElements);
  const envelope: ClipboardEnvelope = { type: 'whiteboard/clipboard', version: 1, sourceBoardId, elements };
  validateEnvelope(envelope); const text = JSON.stringify(envelope); checkBytes(text); return text;
}

/** Unrelated or non-JSON text returns null. Recognized malformed envelopes throw a clear error. */
export function parseClipboard(text: string): ClipboardEnvelope | null {
  checkBytes(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!plain(value) || value.type !== 'whiteboard/clipboard') return null;
  validateEnvelope(value);
  return { ...value, elements: value.elements.map(element => deriveElementGeometry(structuredClone(element))).sort(compareElements) };
}

/** Prepare validated values only; the caller applies them in one BoardDocument transaction. */
export function preparePastedElements(envelope: ClipboardEnvelope, options: PasteOptions): Element[] {
  validateEnvelope(envelope); checkBytes(JSON.stringify(envelope));
  if (!nonempty(options.targetBoardId) || !Number.isFinite(options.center.x) || !Number.isFinite(options.center.y)) fail('paste destination is invalid');
  if (options.newIds.length !== envelope.elements.length || new Set(options.newIds).size !== options.newIds.length || options.newIds.some(id => !nonempty(id))) fail('provide one unique new ID per element');
  const originalIds = new Set(envelope.elements.map(element => element.id));
  if (options.newIds.some(id => originalIds.has(id))) fail('new IDs must differ from the copied IDs');
  const idMap = new Map(envelope.elements.map((element, index) => [element.id, options.newIds[index]!]));
  const elements = envelope.elements.map(element => deriveElementGeometry(structuredClone(element))).sort(compareElements);
  const bounds = contentBounds(elements);
  const delta = { x: options.center.x - bounds.x - bounds.w / 2, y: options.center.y - bounds.y - bounds.h / 2 };
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) fail('selection bounds are invalid');
  let index = options.highestIndex;
  const movePoint = (point: Point): Point => ({ x: point.x + delta.x, y: point.y + delta.y });
  return elements.map(element => {
    index = generateKeyBetween(index, null);
    let pasted = { ...element, id: idMap.get(element.id)!, index, x: element.x + delta.x, y: element.y + delta.y } as Element;
    if (pasted.type === 'connector') {
      const moveBinding = (binding: Binding): Binding => 'elementId' in binding
        ? { ...binding, elementId: idMap.get(binding.elementId)!, fallback: movePoint(binding.fallback) }
        : movePoint(binding);
      pasted = { ...pasted, props: { ...pasted.props, start: moveBinding(pasted.props.start), end: moveBinding(pasted.props.end) } };
    } else if (pasted.type === 'stroke') {
      pasted = deriveElementGeometry({ ...pasted, props: { ...pasted.props, points: pasted.props.points.map((number, coordinate) => coordinate % 3 === 0 ? number + delta.x : coordinate % 3 === 1 ? number + delta.y : number) } });
    } else if (pasted.type === 'image') {
      const mapped = options.imageAssetIds?.get(pasted.props.assetId);
      if (envelope.sourceBoardId !== options.targetBoardId && !nonempty(mapped)) fail(`image asset ${pasted.props.assetId} must be copied to the destination board first`);
      if (mapped !== undefined) {
        if (!nonempty(mapped)) fail('mapped image asset ID is invalid');
        pasted = { ...pasted, props: { ...pasted.props, assetId: mapped } };
      }
    }
    assertValidElement(pasted); return pasted;
  });
}
