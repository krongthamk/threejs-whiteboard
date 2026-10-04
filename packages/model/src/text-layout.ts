import generated from './font-metrics.generated.json' with { type: 'json' };
import type { Element, ShapeTextProps, TextProps } from './types.js';

interface FontMetrics {
  unitsPerEm: number;
  advances: Record<string, number>;
  pairs: Record<string, number>;
  ligatures: Record<string, number>;
  terminals: Record<string, number>;
  pairTerminals: Record<string, number>;
  offsets: Record<string, number>;
  pairOffsets: Record<string, number>;
}
const FONT_METRICS: Record<string, FontMetrics> = generated.fonts;
export const STICKY_TEXT_INSET = 12;
export const STICKY_CORNER_RADIUS = 6;
export const TEXT_LINE_HEIGHT = 1.25;
export interface TextBlock extends TextProps {
  insetX: number;
  insetY: number;
  verticalAlign: ShapeTextProps['verticalAlign'];
}

/** Shared content box metadata; only free auto-size text owns its outer box. */
export function textBlock(element: Element): TextBlock | null {
  if (element.type === 'text') return { ...element.props, insetX: 0, insetY: 0, verticalAlign: 'top' };
  if (element.type === 'sticky') return { ...element.props, insetX: STICKY_TEXT_INSET, insetY: STICKY_TEXT_INSET, verticalAlign: 'top' };
  if ((element.type !== 'rect' && element.type !== 'ellipse') || typeof element.props.text !== 'string') return null;
  const ellipseInset = (dimension: number): number => Math.max(STICKY_TEXT_INSET, dimension * (1 - 1 / Math.SQRT2) / 2);
  return { text: element.props.text, align: element.props.align, autoSize: element.props.autoSize, verticalAlign: element.props.verticalAlign,
    insetX: element.type === 'ellipse' ? ellipseInset(element.w) : STICKY_TEXT_INSET,
    insetY: element.type === 'ellipse' ? ellipseInset(element.h) : STICKY_TEXT_INSET };
}
export type ShippedFontFamily = 'Inter' | 'IBM Plex Mono' | 'Noto Sans JP';
export interface FontRun { family: ShippedFontFamily; text: string; start: number; end: number }

export function resolvedFontFamily(family: string): 'Inter' | 'IBM Plex Mono' {
  return family.toLowerCase().includes('mono') ? 'IBM Plex Mono' : 'Inter';
}

function coveredFont(character: string, primary: ShippedFontFamily, previous?: ShippedFontFamily): ShippedFontFamily | null {
  const covers = (family: ShippedFontFamily) => Object.hasOwn(FONT_METRICS[family]!.advances, character);
  return previous && (covers(previous) || /\s/u.test(character)) ? previous
    : covers(primary) ? primary : covers('Noto Sans JP') ? 'Noto Sans JP' : null;
}
const codePointLabel = (point: number): string => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;

/** Uses the same cmap, fallback priority and whitespace exceptions as PDF coverage. */
export function unsupportedFontCodePoints(text: string, fontFamily = 'Inter', previousFont?: ShippedFontFamily): number[] {
  const primary = fontFamily === 'Noto Sans JP' ? fontFamily : resolvedFontFamily(fontFamily);
  const missing = new Set<number>();
  let previous = previousFont;
  for (const character of text) {
    const family = coveredFont(character, primary, previous);
    if (!family && !/\s/u.test(character)) missing.add(character.codePointAt(0)!);
    previous = family ?? primary;
  }
  return [...missing].sort((a, b) => a - b);
}

export function fontCoverageWarning(points: readonly number[]): string {
  return `Some text uses characters without a shipped font (${points.map(codePointLabel).join(', ')}). Text layout may be approximate, and PDF export cannot include those characters.`;
}

/** Pinned Troika 0.52.5 keeps the preceding font when it covers the next glyph,
 * including across whitespace/newlines. Offsets refer to unnormalized UTF-16 source.
 */
export function resolveFontRuns(text: string, fontFamily = 'Inter', options: { previousFont?: ShippedFontFamily; strict?: boolean } = {}): FontRun[] {
  const primary = fontFamily === 'Noto Sans JP' ? fontFamily : resolvedFontFamily(fontFamily);
  const runs: FontRun[] = [];
  let previous = options.previousFont, start = 0;
  for (const character of text) {
    const family = coveredFont(character, primary, previous);
    if (options.strict && !family && !/\s/u.test(character)) throw new Error(`PDF export has no shipped font for ${codePointLabel(character.codePointAt(0)!)}.`);
    const selected = family ?? primary, end = start + character.length, last = runs.at(-1);
    if (last?.family === selected) { last.text += character; last.end = end; }
    else runs.push({ family: selected, text: character, start, end });
    previous = selected; start = end;
  }
  return runs;
}

function tokenAdvance(token: string, metrics: FontMetrics): number {
  return metrics.advances[token] ?? metrics.ligatures[token] ?? (/\p{Mark}|[\u200B-\u200D\uFE00-\uFE0F]/u.test(token) ? 0 : token === '\t' ? metrics.advances[' ']! * 4 : metrics.unitsPerEm);
}

function fontTokens(text: string, metrics: FontMetrics): string[] {
  const ligatures = Object.keys(metrics.ligatures).sort((a, b) => b.length - a.length);
  const tokens: string[] = [];
  for (let at = 0; at < text.length;) {
    const token = ligatures.find(value => text.startsWith(value, at)) ?? String.fromCodePoint(text.codePointAt(at)!);
    tokens.push(token); at += token.length;
  }
  return tokens;
}

function measureRun(text: string, metrics: FontMetrics): number {
  let total = 0, previous = '', terminal = 0;
  for (const token of fontTokens(text, metrics)) {
    if (token === '\n' || token === '\r') { previous = ''; terminal = 0; }
    else {
      total += tokenAdvance(token, metrics) + (previous ? metrics.pairs[previous + token] ?? 0 : 0);
      terminal = (metrics.terminals[token] ?? 0) + (previous ? metrics.pairTerminals[previous + token] ?? 0 : 0);
      previous = token;
    }
  }
  return total + terminal;
}

/** SVG/PDF cannot select the same complete GPOS lookup set as pinned Troika.
 * Position affected tokens explicitly using generated glyph offsets. Ordinary
 * font runs stay grouped, preserving native kerning and ligatures within them.
 */
export function positionFontRuns(text: string, fontSize: number, fontFamily = 'Inter', previousFont?: ShippedFontFamily): (FontRun & { x: number })[] {
  const output: (FontRun & { x: number })[] = [];
  let x = 0;
  for (const run of resolveFontRuns(text, fontFamily, { previousFont })) {
    const metrics = FONT_METRICS[run.family]!, scale = fontSize / metrics.unitsPerEm, tokens = fontTokens(run.text, metrics);
    // PDF emits cmap glyphs without GSUB; absolute ligature-token starts keep
    // its small internal advance difference from accumulating across the line.
    const requiresPositions = tokens.some(token => metrics.terminals[token] || metrics.offsets[token] || Object.hasOwn(metrics.ligatures, token));
    if (!requiresPositions) output.push({ ...run, x });
    else {
      let pen = 0, previous = '', start = run.start;
      for (const token of tokens) {
        if (previous) pen += metrics.pairs[previous + token] ?? 0;
        const offset = (metrics.offsets[token] ?? 0) + (previous ? metrics.pairOffsets[previous + token] ?? 0 : 0);
        output.push({ family: run.family, text: token, start, end: start + token.length, x: x + (pen + offset) * scale });
        pen += tokenAdvance(token, metrics); start += token.length; previous = token;
      }
    }
    x += measureRun(run.text, metrics) * scale;
  }
  return output;
}

/** Prefix advances let ordinary wraps measure slices in constant time, without
 * re-resolving each line to the primary font. Ligature-bearing slices are shaped
 * separately because wrapping can split a ligature. Newlines reset kerning only.
 */
function textMetrics(text: string, fontSize: number, fontFamily: string) {
  const widths = new Float64Array(text.length + 1), adjustments = new Float64Array(text.length + 1);
  const runs = resolveFontRuns(text, fontFamily);
  if (runs.some(run => {
    const metrics = FONT_METRICS[run.family]!;
    return Object.keys(metrics.ligatures).some(token => run.text.includes(token)) || Object.keys(metrics.terminals).some(token => run.text.includes(token));
  })) {
    return (start: number, end: number) => {
      let width = 0;
      for (const run of runs) if (run.start < end && run.end > start) {
        const metrics = FONT_METRICS[run.family]!;
        width += measureRun(text.slice(Math.max(start, run.start), Math.min(end, run.end)), metrics) * fontSize / metrics.unitsPerEm;
      }
      return width;
    };
  }
  let total = 0;
  for (const run of runs) {
    const metrics = FONT_METRICS[run.family]!, scale = fontSize / metrics.unitsPerEm;
    let at = run.start, previous = '';
    for (const character of run.text) {
      let advance = 0, adjustment = 0;
      if (character === '\n' || character === '\r') previous = '';
      else {
        advance = tokenAdvance(character, metrics);
        adjustment = previous ? metrics.pairs[previous + character] ?? 0 : 0;
        previous = character;
      }
      adjustments[at] = adjustment * scale;
      for (let i = 1; i < character.length; i++) widths[at + i] = total;
      total += (advance + adjustment) * scale; at += character.length; widths[at] = total;
    }
  }
  return (start: number, end: number) => end === start ? 0 : widths[end]! - widths[start]! - adjustments[start]!;
}

/** Pure metrics generated from the exact WOFF files shipped with the app. */
export function measureTextWidth(text: string, fontSize: number, fontFamily = 'Inter'): number {
  return textMetrics(text, fontSize, fontFamily)(0, text.length);
}

export function textSize(text: string, fontSize: number, fontFamily = 'Inter'): { w: number; h: number } {
  const measure = textMetrics(text, fontSize, fontFamily);
  let start = 0, w = 1, lines = 1;
  for (let at = 0; at <= text.length; at++) if (at === text.length || text[at] === '\n') {
    w = Math.max(w, measure(start, at)); start = at + 1; if (at < text.length) lines++;
  }
  return { w, h: lines * fontSize * TEXT_LINE_HEIGHT };
}

export interface TextLayoutLine {
  text: string;
  /** UTF-16 offsets into original props.text, excluding a consumed wrap separator. */
  start: number;
  end: number;
  width: number;
}
export interface TextLayout {
  /** Text sent to troika: explicit newlines, no automatic wrapping. */
  text: string;
  lines: TextLayoutLine[];
  /** Maps every UTF-16 caret boundary, including the final boundary. */
  sourceToRendered: number[];
  renderedToSource: number[];
  /** Shape-only offset within the padded content box, including negative overflow. */
  verticalOffset?: number;
}

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Grapheme rules use the platform's Unicode tables. Build once per wrapped layout;
 * interior UTF-16 offsets remain valid when a space plus mark loses its separator.
 */
function graphemeBoundaries(text: string): Uint32Array {
  const boundaries = new Uint32Array(text.length + 1);
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    const end = index + segment.length;
    boundaries.fill(end, index, end);
  }
  boundaries[text.length] = text.length;
  return boundaries;
}

/** Explicit shared wraps plus source offsets keep SVG, troika, caret and selections aligned. */
export function textLayout(element: Element): TextLayout {
  const block = textBlock(element);
  if (!block) return { text: '', lines: [], sourceToRendered: [0], renderedToSource: [0] };
  const source = block.text;
  const maxWidth = element.type === 'text' && block.autoSize ? Infinity : Math.max(1, element.w - block.insetX * 2);
  const measure = textMetrics(source, element.style.fontSize, element.style.fontFamily);
  const boundaries = maxWidth === Infinity ? null : graphemeBoundaries(source);
  const lines: TextLayoutLine[] = [];
  let start = 0;
  while (start <= source.length) {
    const paragraphEnd = source.indexOf('\n', start);
    const end = paragraphEnd === -1 ? source.length : paragraphEnd;
    if (start === end) lines.push({ text: '', start, end, width: 0 });
    if (maxWidth === Infinity && start < end) {
      const text = source.slice(start, end);
      lines.push({ text, start, end, width: measure(start, end) });
      start = end;
    }
    while (start < end) {
      let cursor = start, fit = start, breakAt = -1;
      while (cursor < end) {
        const next = Math.min(end, boundaries![cursor]!);
        // Spaces are valid boundaries even when the space itself extends past the width.
        if (source[cursor] === ' ' || source[cursor] === '\t') breakAt = cursor;
        if (measure(start, next) > maxWidth && fit > start) break;
        fit = next; cursor = next;
      }
      let lineEnd = fit, nextStart = fit;
      if (fit < end && breakAt > start) { lineEnd = breakAt; nextStart = breakAt + 1; }
      const text = source.slice(start, lineEnd);
      lines.push({ text, start, end: lineEnd, width: measure(start, lineEnd) });
      start = nextStart;
    }
    // A consumed final separator still has two distinct caret boundaries.
    // Preserve the boundary after it as the start of an empty final line.
    if (lines.at(-1)!.end < end) lines.push({ text: '', start: end, end, width: 0 });
    if (paragraphEnd === -1) break;
    start = paragraphEnd + 1;
  }

  const sourceToRendered = new Array<number>(source.length + 1);
  const renderedToSource: number[] = [0];
  let rendered = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const renderedStart = rendered.length;
    // At an inserted wrap boundary choose the beginning of the next line for a source caret.
    for (let i = line.start; i <= line.end; i++) {
      sourceToRendered[i] = renderedStart + i - line.start;
      renderedToSource[renderedStart + i - line.start] = i;
    }
    rendered += line.text;
    if (index < lines.length - 1) {
      const nextStart = lines[index + 1]!.start;
      for (let i = line.end + 1; i < nextStart; i++) sourceToRendered[i] = rendered.length;
      renderedToSource[rendered.length] = line.end;
      rendered += '\n';
      renderedToSource[rendered.length] = nextStart;
    }
  }
  sourceToRendered[source.length] = rendered.length;
  renderedToSource[rendered.length] = source.length;
  const layout: TextLayout = { text: rendered, lines, sourceToRendered, renderedToSource };
  if (element.type === 'rect' || element.type === 'ellipse') {
    const spareHeight = Math.max(0, element.h - block.insetY * 2) - lines.length * element.style.fontSize * TEXT_LINE_HEIGHT;
    layout.verticalOffset = block.verticalAlign === 'middle' ? spareHeight / 2 : block.verticalAlign === 'bottom' ? spareHeight : 0;
  }
  return layout;
}

export function textLines(element: Element): string[] { return textLayout(element).lines.map(line => line.text); }
