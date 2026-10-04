import { generateNKeysBetween } from 'fractional-indexing';
import { assertSafeImageDimensions, MAX_IMAGE_BYTES, readImageHeader } from './image-header.js';
import { assertValidElement, createElement, isWellFormedString, MAX_COORDINATE, MAX_FONT_SIZE, MAX_TEXT_LENGTH } from './schema.js';
import { resolveBinding, rotatePoint } from './geometry.js';
import { DEFAULT_STYLE, type Binding, type Element, type ElementStyle, type Point, type ShapeTextProps } from './types.js';

export const MAX_IMPORT_ELEMENTS = 10_000;
export const MAX_EXCALIDRAW_IMAGES = 100;
export const MAX_EXCALIDRAW_BYTES = 50 * 1024 * 1024;
export interface ExcalidrawImageTransform {
  /** Source rectangle in decoded, EXIF-oriented image pixels. */
  crop?: { x: number; y: number; width: number; height: number };
  flipX: boolean;
  flipY: boolean;
}
export interface ExcalidrawImport {
  elements: Element[];
  /** Temporary image assetIds must be replaced by uploaded assetIds before insertion. */
  images: { elementId: string; mimeType: string; bytes: Uint8Array; naturalW: number; naturalH: number; transform?: ExcalidrawImageTransform }[];
  report: { imported: number; skipped: { id: string; type: string; reason: string }[]; substituted: string[] };
}
type Raw = Record<string, unknown>;
interface Source { raw: Raw; id: string; type: string; position: number }
const plain = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function fail(reason: string): never { throw new Error(reason); }
function fatal(reason: string): never { return fail('Invalid Excalidraw import: ' + reason); }
const number = (value: unknown, name: string, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!finite(value)) fail(name + ' must be a finite number');
  return value as number;
};
const string = (value: unknown, name: string, fallback?: string): string => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!isWellFormedString(value)) fail(name + ' must be well-formed text');
  return value as string;
};
const enumValue = <T extends string>(value: unknown, values: readonly T[], name: string, fallback: T): T => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !values.includes(value as T)) fail(name + ' is unsupported');
  return value as T;
};

// CSS named color constants are defined below; no browser parser or renderer dependency.
function color(value: unknown, name: string, fallback: string): string | null {
  const input = string(value, name, fallback).trim().toLowerCase();
  if (input === 'transparent' || input === 'none') return null;
  let match = /^#([\da-f]{3}|[\da-f]{6})$/.exec(input);
  if (match) return '#' + (match[1]!.length === 3 ? [...match[1]!].map(c => c + c).join('') : match[1]);
  // Recognize alpha-bearing hex only to preserve fully opaque/transparent equivalents.
  match = /^#([\da-f]{4}|[\da-f]{8})$/.exec(input);
  if (match) {
    const hex = match[1]!.length === 4 ? [...match[1]!].map(c => c + c).join('') : match[1]!;
    const alpha = parseInt(hex.slice(6), 16);
    if (alpha === 0) return null;
    if (alpha === 255) return '#' + hex.slice(0, 6);
    fail(name + ' has unsupported independent alpha');
  }
  if (Object.hasOwn(CSS_COLORS, input)) return '#' + CSS_COLORS[input]!.toString(16).padStart(6, '0');
  const rgb = /^(rgb|rgba)\(\s*(\d+)(%?)\s*,\s*(\d+)(%?)\s*,\s*(\d+)(%?)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/.exec(input);
  const hsl = /^(hsl|hsla)\(\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)%\s*,\s*(\d*\.?\d+)%(?:\s*,\s*(\d*\.?\d+))?\s*\)$/.exec(input);
  const alpha = (kind: string, value: string | undefined): number => {
    if (kind.endsWith('a') !== (value !== undefined)) fail(name + ' has invalid color syntax');
    const n = value === undefined ? 1 : Number(value);
    if (!finite(n) || n < 0 || n > 1) fail(name + ' has invalid alpha');
    if (n !== 0 && n !== 1) fail(name + ' has unsupported independent alpha');
    return n;
  };
  let channels: number[];
  if (rgb) {
    const a = alpha(rgb[1]!, rgb[8]);
    if (rgb[3] !== rgb[5] || rgb[3] !== rgb[7]) fail(name + ' mixes RGB channel units');
    const max = rgb[3] ? 100 : 255; channels = [2, 4, 6].map(i => Number(rgb[i]));
    if (channels.some(n => !finite(n) || n < 0 || n > max)) fail(name + ' has out-of-range RGB channels');
    if (!a) return null;
    channels = channels.map(n => n / max);
  } else if (hsl) {
    const a = alpha(hsl[1]!, hsl[5]);
    const hue = Number(hsl[2]), s = Number(hsl[3]) / 100, l = Number(hsl[4]) / 100;
    if (![hue, s, l].every(finite) || s < 0 || s > 1 || l < 0 || l > 1) fail(name + ' has out-of-range HSL channels');
    if (!a) return null;
    const h = (hue % 360) / 360, p = l <= .5 ? l * (1 + s) : l + s - l * s, q = 2 * l - p;
    const channel = (t: number) => {
      t = (t + 1) % 1;
      return t < 1 / 6 ? q + (p - q) * 6 * t : t < .5 ? p : t < 2 / 3 ? q + (p - q) * 6 * (2 / 3 - t) : q;
    };
    channels = s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  } else return fail(name + ' is not a supported opaque CSS color');
  return '#' + channels.map(n => Math.round(n * 255).toString(16).padStart(2, '0')).join('');
}

function points(raw: Raw): Point[] {
  if (!Array.isArray(raw.points) || !raw.points.length) fail('points are missing');
  const local = raw.points.map(value => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) fail('points must be finite coordinate pairs');
    const [x, y] = value as number[];
    if (Math.abs(x!) > MAX_COORDINATE || Math.abs(y!) > MAX_COORDINATE) fail('point coordinates exceed the model limit');
    return { x: x!, y: y! };
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of local) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const x = number(raw.x, 'x'), y = number(raw.y, 'y'), angle = number(raw.angle, 'angle', 0);
  const center = { x: x + (minX + maxX) / 2, y: y + (minY + maxY) / 2 };
  return local.map(p => rotatePoint({ x: x + p.x, y: y + p.y }, center, angle));
}
function decodeDataURL(value: unknown): { bytes: Uint8Array; mimeType: string; width: number; height: number } {
  const data = string(value, 'image dataURL'), match = /^data:([^;,]+);base64,/i.exec(data);
  if (!match || !['image/png', 'image/jpeg', 'image/webp'].includes(match[1]!.toLowerCase())) fail('only PNG, JPEG and WebP image data URLs are supported');
  const payload = data.slice(match[0].length), padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  if (!payload.length || payload.length % 4 || /[^A-Za-z0-9+/]/.test(payload.slice(0, payload.length - padding))) fail('image base64 is malformed');
  if (payload.length / 4 * 3 - padding > MAX_IMAGE_BYTES) fail('image exceeds the 20 MiB limit');
  let binary: string;
  try { binary = atob(payload); } catch { return fail('image base64 is malformed'); }
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), header = readImageHeader(bytes);
  assertSafeImageDimensions(header.width, header.height);
  if (match[1]!.toLowerCase() !== header.mimeType) fail('image MIME does not match its encoded bytes');
  return { bytes, mimeType: header.mimeType, width: header.width, height: header.height };
}

/** Convert untrusted Excalidraw JSON without I/O or document writes. Bad elements are reported independently. */
export function importExcalidraw(json: unknown, options: { newId(): string; firstIndex: string | null; maxElements?: number }): ExcalidrawImport {
  if (!plain(json) || (json.type !== 'excalidraw' && json.type !== 'excalidraw/clipboard') || !Array.isArray(json.elements)) fatal('expected an Excalidraw document or clipboard envelope');
  if (json.type === 'excalidraw' && json.version !== 2) fatal('unsupported document version');
  if (!options || typeof options.newId !== 'function' || !(options.firstIndex === null || typeof options.firstIndex === 'string')) fatal('invalid conversion options');
  const maximum = options.maxElements === undefined ? MAX_IMPORT_ELEMENTS : options.maxElements;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_IMPORT_ELEMENTS) fatal('maxElements must be 1–10,000');
  if (json.elements.length > maximum) fatal('element count exceeds ' + maximum);
  if (json.elements.filter(raw => plain(raw) && raw.type === 'image' && raw.isDeleted !== true).length > MAX_EXCALIDRAW_IMAGES) fatal('image count exceeds 100');
  try { generateNKeysBetween(options.firstIndex, null, 1); } catch { fatal('firstIndex is invalid'); }
  let serialized: string;
  try { serialized = JSON.stringify(json); } catch { return fatal('source is not serializable JSON'); }
  if (serialized.length > MAX_EXCALIDRAW_BYTES || new TextEncoder().encode(serialized).byteLength > MAX_EXCALIDRAW_BYTES) fatal('source exceeds the 50 MiB limit');

  const result: ExcalidrawImport = { elements: [], images: [], report: { imported: 0, skipped: [], substituted: [] } };
  const losses = new Set<string>(); let candidateLosses = new Set<string>();
  const acceptLosses = () => { for (const loss of candidateLosses) losses.add(loss); };
  const groups = new Set<string>(), sources: Source[] = [], occurrences = new Map<string, number>();
  for (const raw of json.elements) if (plain(raw) && isWellFormedString(raw.id) && raw.id) occurrences.set(raw.id, (occurrences.get(raw.id) ?? 0) + 1);
  const skip = (source: Pick<Source, 'id' | 'type'>, reason: string) => { result.report.skipped.push({ id: source.id, type: source.type, reason }); };
  const warn = (source: Source, reason: string) => {
    let display = source.id;
    if (display.length > 128) {
      display = display.slice(0, 128);
      const lastUnit = display.charCodeAt(display.length - 1);
      if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) display = display.slice(0, -1);
      display += '… (element ' + (source.position + 1) + ')';
    }
    candidateLosses.add(display + ': ' + reason);
  };
  for (const [position, raw] of json.elements.entries()) {
    const id = plain(raw) && isWellFormedString(raw.id) && raw.id ? raw.id : 'element #' + (position + 1);
    const type = plain(raw) && isWellFormedString(raw.type) ? raw.type : 'unknown';
    if (!plain(raw) || !isWellFormedString(raw.id) || !raw.id || !isWellFormedString(raw.type) || !raw.type) { skip({ id, type }, 'element identity/type is missing or malformed'); continue; }
    if (raw.isDeleted === true) continue;
    if (raw.isDeleted !== undefined && typeof raw.isDeleted !== 'boolean') { skip({ id, type }, 'isDeleted must be boolean'); continue; }
    sources.push({ raw, id, type, position });
  }
  const ambiguous = new Set([...occurrences].filter(([, count]) => count > 1).map(([id]) => id));
  const allIds = new Set<string>();
  for (const raw of json.elements) if (plain(raw) && isWellFormedString(raw.id) && raw.id) allIds.add(raw.id);
  const sourceTypes = new Map(sources.map(source => [source.id, source.type]));
  const sourcePositions = new Map(sources.map(source => [source.id, source.position]));
  const allocated = new Set<string>(), native = new Map<string, Element>(), staged = new Map<number, Element>();
  const allocate = (): string => {
    let id: string;
    try { id = options.newId(); } catch { return fatal('newId failed to allocate an ID'); }
    if (!isWellFormedString(id) || !id || allocated.has(id) || allIds.has(id)) fatal('newId must provide fresh unique, well-formed IDs');
    allocated.add(id); return id;
  };
  const font = (source: Source): string => {
    const value = number(source.raw.fontFamily, 'fontFamily', 2);
    if (!Number.isInteger(value) || value < 1) fail('fontFamily is invalid');
    const names: Record<number, string> = { 1: 'Virgil', 2: 'Helvetica', 3: 'Cascadia', 5: 'Excalifont', 6: 'Nunito', 7: 'Lilita One', 8: 'Comic Shanns' };
    const family = value === 3 ? 'IBM Plex Mono' : 'Inter';
    candidateLosses.add((names[value] ?? 'Font ' + value) + ' substituted with ' + family);
    return family;
  };
  const box = (source: Source) => {
    const r = source.raw, x = number(r.x, 'x'), y = number(r.y, 'y'), w = number(r.width, 'width'), h = number(r.height, 'height'), rotation = number(r.angle, 'angle', 0);
    if ([x, y, w, h].some(n => Math.abs(n) > MAX_COORDINATE) || w < 0 || h < 0) fail('geometry exceeds the model limits');
    return { x, y, w, h, rotation };
  };
  const style = (source: Source, category: 'shape' | 'text' | 'stroke' | 'frame' | 'image'): ElementStyle => {
    const r = source.raw, opacity = number(r.opacity, 'opacity', 100) / 100, strokeWidth = number(r.strokeWidth, 'strokeWidth', 2);
    if (opacity < 0 || opacity > 1 || strokeWidth < 0 || strokeWidth > MAX_COORDINATE) fail('opacity or strokeWidth is out of range');
    const value = { ...DEFAULT_STYLE, opacity, strokeWidth };
    if (category === 'image') return value;
    const stroke = color(r.strokeColor, 'strokeColor', DEFAULT_STYLE.stroke);
    if (category === 'text') {
      value.color = stroke ?? '#000000'; if (stroke === null) value.opacity = 0;
      value.fontFamily = font(source); value.fontSize = number(r.fontSize, 'fontSize', 20);
      if (value.fontSize <= 0 || value.fontSize > MAX_FONT_SIZE) fail('fontSize exceeds the model limit');
      return value;
    }
    value.stroke = stroke ?? '#000000';
    if (category === 'stroke') { if (stroke === null) value.opacity = 0; return value; }
    value.fill = category === 'frame' ? 'none' : color(r.backgroundColor, 'backgroundColor', 'transparent') ?? 'none';
    if (stroke === null) value.strokeWidth = 0;
    return value;
  };
  const text = (source: Source): string => {
    const r = source.raw, value = string(r.originalText === undefined ? r.text : r.originalText, 'text');
    if (value.length > MAX_TEXT_LENGTH) fail('text exceeds the 50,000 character limit');
    return value;
  };
  const textProps = (source: Source, shape: boolean): ShapeTextProps => ({
    text: text(source), autoSize: false,
    align: enumValue(source.raw.textAlign, ['left', 'center', 'right'], 'textAlign', 'left'),
    verticalAlign: enumValue(source.raw.verticalAlign, ['top', 'middle', 'bottom'], 'verticalAlign', shape ? 'middle' : 'top'),
  });
  const textLosses = (source: Source) => {
    if (source.raw.lineHeight !== undefined && source.raw.lineHeight !== 1.25) warn(source, 'line height replaced with native 1.25');
  };
  const genericLosses = (source: Source, element: Element) => {
    const r = source.raw;
    if (Array.isArray(r.groupIds)) for (const id of r.groupIds) if (typeof id === 'string' && id) groups.add(id);
    if (r.frameId) warn(source, 'frame membership and clipping dropped');
    const visibleStroke = element.style.opacity > 0 && element.style.strokeWidth > 0;
    const visibleFill = element.style.opacity > 0 && element.style.fill !== 'none' && ['rectangle', 'ellipse', 'diamond'].includes(source.type);
    if ((visibleStroke || visibleFill) && ['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'freedraw'].includes(source.type) && r.roughness !== undefined && r.roughness !== 0) candidateLosses.add('Hand-drawn roughness replaced with native geometry');
    if (visibleFill && r.fillStyle !== undefined && r.fillStyle !== 'solid' && ['rectangle', 'ellipse', 'diamond'].includes(source.type)) candidateLosses.add('Hatched/pattern fills replaced with solid fills');
    if (visibleStroke && r.strokeStyle !== undefined && r.strokeStyle !== 'solid' && source.type !== 'text' && source.type !== 'image') candidateLosses.add('Dashed/dotted strokes replaced with solid strokes');
    if (r.roundness) warn(source, 'roundness dropped');
    if (r.link) warn(source, 'element link dropped');
    if (r.locked) warn(source, 'element lock dropped');
  };
  const commit = (source: Source, element: Element) => { assertValidElement(element); staged.set(source.position, element); native.set(source.id, element); genericLosses(source, element); };
  const files = plain(json.files) ? json.files : {};
  const decoded = new Map<string, ReturnType<typeof decodeDataURL>>();
  const labels: Source[] = [], arrows: Source[] = [];
  for (const source of sources) {
    if (ambiguous.has(source.id)) { skip(source, 'duplicate source ID is ambiguous'); continue; }
    if (source.type === 'text') { labels.push(source); continue; }
    if (source.type === 'arrow') { arrows.push(source); continue; }
    candidateLosses = new Set();
    try {
      const r = source.raw;
      if (!['rectangle', 'ellipse', 'diamond', 'frame', 'magicframe', 'freedraw', 'line', 'image'].includes(source.type)) { skip(source, 'unsupported element type'); continue; }
      const geometry = box(source);
      if (['rectangle', 'ellipse', 'diamond', 'frame', 'magicframe'].includes(source.type)) {
        const frame = source.type === 'frame' || source.type === 'magicframe';
        const element = createElement(source.type === 'ellipse' ? 'ellipse' : 'rect', { ...geometry, id: allocate(), style: style(source, frame ? 'frame' : 'shape') });
        if (source.type === 'diamond') warn(source, 'diamond replaced with rectangle');
        if (frame) {
          warn(source, 'frame replaced with transparent rectangle; frame behavior dropped');
          const name = r.name === null ? '' : string(r.name, 'frame name', '');
          if (name.length > MAX_TEXT_LENGTH) fail('frame name exceeds the text limit');
          if (name) element.props = { text: name, autoSize: false, align: 'left', verticalAlign: 'top' };
        }
        commit(source, element);
      } else if (source.type === 'freedraw' || source.type === 'line') {
        const world = points(r), supplied = r.pressures;
        if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length !== 0 && supplied.length !== world.length)) fail('pressures must match the point count');
        const pressures = Array.isArray(supplied) && supplied.length ? supplied : world.map(() => .5);
        if (pressures.some(p => !finite(p) || p < 0 || p > 1)) fail('pressures must be between 0 and 1');
        const strokeStyle = style(source, 'stroke');
        if (strokeStyle.opacity > 0 && strokeStyle.strokeWidth > 0) {
          if (source.type === 'line') warn(source, 'line replaced with native pressure stroke; routing and width may differ');
          else warn(source, 'freehand outline replaced with native pressure stroke');
        }
        commit(source, createElement('stroke', { id: allocate(), style: strokeStyle, props: {
          points: world.flatMap((p, i) => [p.x, p.y, source.type === 'line' ? .5 : pressures[i] as number]), simplified: false,
        } }));
      } else if (source.type === 'image') {
        const fileId = string(r.fileId, 'fileId');
        if (!fileId || !Object.hasOwn(files, fileId) || !plain(files[fileId])) fail('image file is missing');
        const file = files[fileId];
        let image = decoded.get(fileId);
        if (!image) { image = decodeDataURL(file.dataURL); decoded.set(fileId, image); }
        if (file.mimeType !== undefined && file.mimeType !== image.mimeType) fail('image file MIME does not match its encoded bytes');
        const scale = r.scale === undefined ? [1, 1] : r.scale;
        if (!Array.isArray(scale) || scale.length !== 2 || scale.some(n => n !== 1 && n !== -1)) fail('image scale must contain two +1/-1 flip signs');
        const transform: ExcalidrawImageTransform = { flipX: scale[0] === -1, flipY: scale[1] === -1 };
        if (r.crop !== undefined && r.crop !== null) {
          if (!plain(r.crop)) fail('image crop is malformed');
          const crop = { x: number(r.crop.x, 'crop x'), y: number(r.crop.y, 'crop y'), width: number(r.crop.width, 'crop width'), height: number(r.crop.height, 'crop height') };
          if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > image.width || crop.y + crop.height > image.height) fail('image crop is outside the decoded image');
          if (r.crop.naturalWidth !== undefined || r.crop.naturalHeight !== undefined) {
            const width = number(r.crop.naturalWidth, 'crop naturalWidth'), height = number(r.crop.naturalHeight, 'crop naturalHeight');
            assertSafeImageDimensions(width, height);
            if (width !== image.width || height !== image.height) warn(source, 'crop natural-size metadata corrected from the encoded image header');
          }
          if (crop.x || crop.y || crop.width !== image.width || crop.height !== image.height) transform.crop = crop;
        }
        const element = createElement('image', { ...geometry, id: allocate(), style: style(source, 'image'), props: { assetId: 'import-pending', naturalW: image.width, naturalH: image.height } });
        commit(source, element);
        result.images.push({ elementId: element.id, mimeType: image.mimeType, bytes: image.bytes, naturalW: image.width, naturalH: image.height,
          ...(transform.crop || transform.flipX || transform.flipY ? { transform } : {}) });
      } else skip(source, 'unsupported element type');
      acceptLosses();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid Excalidraw import:')) throw error;
      skip(source, error instanceof Error ? error.message : 'element conversion failed');
    }
  }
  const absorbed = new Set<string>();
  for (const source of labels) {
    candidateLosses = new Set();
    try {
      const r = source.raw, props = textProps(source, true), labelStyle = style(source, 'text'), geometry = box(source);
      const containerId = r.containerId === undefined || r.containerId === null ? null : string(r.containerId, 'containerId');
      const container = containerId ? native.get(containerId) : undefined;
      if (container && ['rectangle', 'ellipse', 'diamond'].includes(sourceTypes.get(containerId!) ?? '') && (container.type === 'rect' || container.type === 'ellipse') && !absorbed.has(containerId!) && !(labelStyle.opacity === 0 && container.style.opacity !== 0)) {
        const updated = { ...container, style: { ...container.style, color: labelStyle.color, fontSize: labelStyle.fontSize, fontFamily: labelStyle.fontFamily },
          props: props.text ? props : {} } as Element;
        if (labelStyle.opacity !== container.style.opacity) warn(source, 'independent label opacity replaced with container opacity');
        if (geometry.rotation !== container.rotation) warn(source, 'independent label angle replaced with container angle');
        assertValidElement(updated); native.set(containerId!, updated);
        staged.set(sourcePositions.get(containerId!)!, updated);
        absorbed.add(containerId!); genericLosses(source, updated); textLosses(source);
        warn(source, 'bound label reflow/placement uses native font metrics and shape insets'); acceptLosses(); continue;
      }
      if (containerId) warn(source, 'container label retained as free text because its container is missing, unsupported, or already labeled');
      const autoSize = r.autoResize === undefined ? true : r.autoResize;
      if (typeof autoSize !== 'boolean') fail('autoResize must be boolean');
      if (props.verticalAlign !== 'top') warn(source, 'free text vertical alignment replaced with top');
      const element = createElement('text', { ...geometry, id: allocate(), style: labelStyle, props: { text: props.text, align: props.align, autoSize } });
      if (element.w !== geometry.w || element.h !== geometry.h) warn(source, 'text dimensions recalculated with native font metrics');
      commit(source, element); textLosses(source); acceptLosses();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid Excalidraw import:')) throw error;
      skip(source, error instanceof Error ? error.message : 'label conversion failed');
    }
  }
  const binding = (source: Source, value: unknown, point: Point, end: string): Binding => {
    if (value === undefined || value === null) return point;
    if (!plain(value) || !isWellFormedString(value.elementId) || !value.elementId) { warn(source, end + ' binding was malformed; kept its point endpoint'); return point; }
    const target = native.get(value.elementId);
    if (!target || target.type === 'connector' || target.w <= 0 || target.h <= 0) { warn(source, end + ' binding target was missing or invalid; kept its point endpoint'); return point; }
    if (value.fixedPoint != null && (!Array.isArray(value.fixedPoint) || value.fixedPoint.length !== 2 || value.fixedPoint.some(n => !finite(n) || n < 0 || n > 1)) ||
      value.mode !== undefined && (typeof value.mode !== 'string' || !['inside', 'orbit', 'skip'].includes(value.mode)) ||
      value.focus !== undefined && (!finite(value.focus) || Math.abs(value.focus) > 1) ||
      value.gap !== undefined && (!finite(value.gap) || value.gap < 0)) {
      warn(source, end + ' binding metadata was malformed; kept its point endpoint'); return point;
    }
    const local = rotatePoint(point, { x: target.x + target.w / 2, y: target.y + target.h / 2 }, -target.rotation);
    const nx = Math.max(0, Math.min(1, (local.x - target.x) / target.w)), ny = Math.max(0, Math.min(1, (local.y - target.y) / target.h));
    const result = { elementId: target.id, nx, ny, fallback: { ...point } };
    const resolved = resolveBinding(result, new Map([[target.id, target]]));
    if (Math.hypot(resolved.x - point.x, resolved.y - point.y) > 1e-7) warn(source, end + ' gapped endpoint projected onto target bounds');
    if (value.gap || value.focus || value.mode === 'orbit' || value.mode === 'skip') warn(source, end + ' gap/focus/orbit binding behavior replaced with native normalized binding');
    return result;
  };
  for (const source of arrows) {
    candidateLosses = new Set();
    try {
      const world = points(source.raw); if (world.length < 2) fail('arrow needs at least two points');
      box(source);
      const kind = source.raw.elbowed === true ? 'elbow' : world.length > 2 ? 'curve' : 'straight';
      if (source.raw.elbowed !== undefined && typeof source.raw.elbowed !== 'boolean') fail('elbowed must be boolean');
      if (kind !== 'straight') warn(source, kind + ' routing replaced with native endpoint-based routing');
      if (source.raw.angle) warn(source, 'linear rotation uses point bounds; rough/curved path centers may differ');
      if (source.raw.startArrowhead) warn(source, 'start arrowhead dropped');
      if (source.raw.endArrowhead !== undefined && source.raw.endArrowhead !== 'arrow') warn(source, 'end arrowhead replaced with native arrow');
      commit(source, createElement('connector', { id: allocate(), style: style(source, 'stroke'), props: {
        start: binding(source, source.raw.startBinding, world[0]!, 'start'), end: binding(source, source.raw.endBinding, world.at(-1)!, 'end'), kind,
      } }));
      acceptLosses();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid Excalidraw import:')) throw error;
      skip(source, error instanceof Error ? error.message : 'arrow conversion failed');
    }
  }
  result.elements = [...staged].sort(([a], [b]) => a - b).map(([, element]) => element);
  const indexes = generateNKeysBetween(options.firstIndex, null, result.elements.length);
  result.elements.forEach((element, i) => { element.index = indexes[i]!; assertValidElement(element); });
  if (groups.size) losses.add(groups.size + ' group(s) dropped');
  result.report.imported = result.elements.length; result.report.substituted = [...losses];
  return result;
}

// Standard CSS named colors; values match THREE 0.186.1 (MIT), src/math/Color.js.
const CSS_COLORS: Readonly<Record<string, number>> = {
  'aliceblue': 0xF0F8FF, 'antiquewhite': 0xFAEBD7, 'aqua': 0x00FFFF, 'aquamarine': 0x7FFFD4, 'azure': 0xF0FFFF,
  'beige': 0xF5F5DC, 'bisque': 0xFFE4C4, 'black': 0x000000, 'blanchedalmond': 0xFFEBCD, 'blue': 0x0000FF,
  'blueviolet': 0x8A2BE2, 'brown': 0xA52A2A, 'burlywood': 0xDEB887, 'cadetblue': 0x5F9EA0, 'chartreuse': 0x7FFF00,
  'chocolate': 0xD2691E, 'coral': 0xFF7F50, 'cornflowerblue': 0x6495ED, 'cornsilk': 0xFFF8DC, 'crimson': 0xDC143C,
  'cyan': 0x00FFFF, 'darkblue': 0x00008B, 'darkcyan': 0x008B8B, 'darkgoldenrod': 0xB8860B, 'darkgray': 0xA9A9A9,
  'darkgreen': 0x006400, 'darkgrey': 0xA9A9A9, 'darkkhaki': 0xBDB76B, 'darkmagenta': 0x8B008B, 'darkolivegreen': 0x556B2F,
  'darkorange': 0xFF8C00, 'darkorchid': 0x9932CC, 'darkred': 0x8B0000, 'darksalmon': 0xE9967A, 'darkseagreen': 0x8FBC8F,
  'darkslateblue': 0x483D8B, 'darkslategray': 0x2F4F4F, 'darkslategrey': 0x2F4F4F, 'darkturquoise': 0x00CED1, 'darkviolet': 0x9400D3,
  'deeppink': 0xFF1493, 'deepskyblue': 0x00BFFF, 'dimgray': 0x696969, 'dimgrey': 0x696969, 'dodgerblue': 0x1E90FF,
  'firebrick': 0xB22222, 'floralwhite': 0xFFFAF0, 'forestgreen': 0x228B22, 'fuchsia': 0xFF00FF, 'gainsboro': 0xDCDCDC,
  'ghostwhite': 0xF8F8FF, 'gold': 0xFFD700, 'goldenrod': 0xDAA520, 'gray': 0x808080, 'green': 0x008000,
  'greenyellow': 0xADFF2F, 'grey': 0x808080, 'honeydew': 0xF0FFF0, 'hotpink': 0xFF69B4, 'indianred': 0xCD5C5C,
  'indigo': 0x4B0082, 'ivory': 0xFFFFF0, 'khaki': 0xF0E68C, 'lavender': 0xE6E6FA, 'lavenderblush': 0xFFF0F5,
  'lawngreen': 0x7CFC00, 'lemonchiffon': 0xFFFACD, 'lightblue': 0xADD8E6, 'lightcoral': 0xF08080, 'lightcyan': 0xE0FFFF,
  'lightgoldenrodyellow': 0xFAFAD2, 'lightgray': 0xD3D3D3, 'lightgreen': 0x90EE90, 'lightgrey': 0xD3D3D3, 'lightpink': 0xFFB6C1,
  'lightsalmon': 0xFFA07A, 'lightseagreen': 0x20B2AA, 'lightskyblue': 0x87CEFA, 'lightslategray': 0x778899, 'lightslategrey': 0x778899,
  'lightsteelblue': 0xB0C4DE, 'lightyellow': 0xFFFFE0, 'lime': 0x00FF00, 'limegreen': 0x32CD32, 'linen': 0xFAF0E6,
  'magenta': 0xFF00FF, 'maroon': 0x800000, 'mediumaquamarine': 0x66CDAA, 'mediumblue': 0x0000CD, 'mediumorchid': 0xBA55D3,
  'mediumpurple': 0x9370DB, 'mediumseagreen': 0x3CB371, 'mediumslateblue': 0x7B68EE, 'mediumspringgreen': 0x00FA9A, 'mediumturquoise': 0x48D1CC,
  'mediumvioletred': 0xC71585, 'midnightblue': 0x191970, 'mintcream': 0xF5FFFA, 'mistyrose': 0xFFE4E1, 'moccasin': 0xFFE4B5,
  'navajowhite': 0xFFDEAD, 'navy': 0x000080, 'oldlace': 0xFDF5E6, 'olive': 0x808000, 'olivedrab': 0x6B8E23,
  'orange': 0xFFA500, 'orangered': 0xFF4500, 'orchid': 0xDA70D6, 'palegoldenrod': 0xEEE8AA, 'palegreen': 0x98FB98,
  'paleturquoise': 0xAFEEEE, 'palevioletred': 0xDB7093, 'papayawhip': 0xFFEFD5, 'peachpuff': 0xFFDAB9, 'peru': 0xCD853F,
  'pink': 0xFFC0CB, 'plum': 0xDDA0DD, 'powderblue': 0xB0E0E6, 'purple': 0x800080, 'rebeccapurple': 0x663399,
  'red': 0xFF0000, 'rosybrown': 0xBC8F8F, 'royalblue': 0x4169E1, 'saddlebrown': 0x8B4513, 'salmon': 0xFA8072,
  'sandybrown': 0xF4A460, 'seagreen': 0x2E8B57, 'seashell': 0xFFF5EE, 'sienna': 0xA0522D, 'silver': 0xC0C0C0,
  'skyblue': 0x87CEEB, 'slateblue': 0x6A5ACD, 'slategray': 0x708090, 'slategrey': 0x708090, 'snow': 0xFFFAFA,
  'springgreen': 0x00FF7F, 'steelblue': 0x4682B4, 'tan': 0xD2B48C, 'teal': 0x008080, 'thistle': 0xD8BFD8,
  'tomato': 0xFF6347, 'turquoise': 0x40E0D0, 'violet': 0xEE82EE, 'wheat': 0xF5DEB3, 'white': 0xFFFFFF,
  'whitesmoke': 0xF5F5F5, 'yellow': 0xFFFF00, 'yellowgreen': 0x9ACD32,
};
