import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement, documentToSvg, measureTextWidth, positionFontRuns, resolveFontRuns, textLayout, textSize } from '../src/index.js';
import metrics from '../src/font-metrics.generated.json';

describe('shipped font metrics', () => {
  it('identifies the exact WOFF bytes used to generate metrics', () => {
    for (const font of Object.values(metrics.fonts)) {
      const data = readFileSync(new URL(`../../app/public/fonts/${font.file}`, import.meta.url));
      expect(createHash('sha256').update(data).digest('hex')).toBe(font.sha256);
    }
  });

  it('uses proportional advances and kerning, with true fixed-width mono advances', () => {
    expect(measureTextWidth('Hello', 24)).toBe(57.84375);
    expect(measureTextWidth('WWW', 24)).toBeGreaterThan(measureTextWidth('iii', 24) * 3);
    expect(measureTextWidth('AV', 24)).toBeLessThan(measureTextWidth('A', 24) + measureTextWidth('V', 24));
    expect(measureTextWidth('WWW', 24, 'IBM Plex Mono')).toBeCloseTo(43.2, 8);
    expect(measureTextWidth('iii', 24, 'IBM Plex Mono')).toBeCloseTo(43.2, 8);
    expect(measureTextWidth('cafe\u0301', 24)).toBe(measureTextWidth('café', 24));
    expect(textSize('WWW\ni', 24).w).toBe(measureTextWidth('WWW', 24));
  });

  it('fits proportional words using actual advances instead of character counts', () => {
    const e = createElement('sticky', { w: 120, props: { text: 'one two three four', align: 'left', autoSize: false } });
    const layout = textLayout(e);
    expect(layout.lines.map(line => line.text)).toEqual(['one two', 'three', 'four']);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(96);
  });

  it('maps UTF-16 carets after inserted wraps, spaces, explicit newlines and surrogate pairs', () => {
    for (const text of ['abcdefghijk', 'one two three four', 'one  two\n\nthree\n', 'A🖊️BCDEFG', 'e\u0301longword']) {
      const element = createElement('text', { w: 40, props: { text, align: 'left', autoSize: false } });
      const layout = textLayout(element);
      expect(layout.sourceToRendered).toHaveLength(text.length + 1);
      expect(layout.renderedToSource).toHaveLength(layout.text.length + 1);
      for (let source = 0; source <= text.length; source++) {
        const rendered = layout.sourceToRendered[source]!;
        expect(Number.isInteger(rendered)).toBe(true);
        expect(layout.renderedToSource[rendered]).toBe(source);
        if (source > 0) expect(rendered).toBeGreaterThanOrEqual(layout.sourceToRendered[source - 1]!);
      }
      for (const line of layout.lines) expect(line.text).toBe(text.slice(line.start, line.end));
    }
    const hard = textLayout(createElement('text', { w: 30, props: { text: 'abcdefghijk', align: 'left', autoSize: false } }));
    expect(hard.text.length).toBeGreaterThan('abcdefghijk'.length);
  });

  it('does not break combining characters or ZWJ sequences between lines', () => {
    const source = 'e\u0301👩‍💻XYZ';
    const layout = textLayout(createElement('text', { w: 1, props: { text: source, align: 'left', autoSize: false } }));
    expect(layout.lines.map(line => line.text)).toEqual(['e\u0301', '👩‍💻', 'X', 'Y', 'Z']);
  });

  it('keeps the actual fallback font across Latin suffixes and explicit newlines', () => {
    expect(resolveFontRuns('abc日本語 \nWWW', 'IBM Plex Mono')).toEqual([
      { family: 'IBM Plex Mono', text: 'abc', start: 0, end: 3 },
      { family: 'Noto Sans JP', text: '日本語 \nWWW', start: 3, end: 11 },
    ]);
    expect(measureTextWidth('日本語 WWWWWWWWWW', 32, 'IBM Plex Mono')).toBeCloseTo(384.128, 9);
    const size = textSize('日本語\nWWWWWWWWWW', 32, 'IBM Plex Mono');
    expect(size.w).toBeCloseTo(280.96, 9); expect(size.h).toBe(80);
    expect(size.w).toBeGreaterThan(measureTextWidth('WWWWWWWWWW', 32, 'IBM Plex Mono') + 80);
    // Source normalization would change the actual selected glyph/font.
    expect(resolveFontRuns('A\u0304')[0]!.family).toBe('Inter');
    expect(resolveFontRuns('Ā')[0]!.family).toBe('Noto Sans JP');
    expect(() => resolveFontRuns('🦄', 'Inter', { strict: true })).toThrow('U+1F984');
  });

  it('measures ligatures and adjacent kerning without counting overlapping substitutions twice', () => {
    // Independently measured through pinned Troika FontParser, at 32px.
    expect(measureTextWidth('fffi', 32, 'Noto Sans JP')).toBeCloseTo(39.776, 9);
    expect(measureTextWidth('office affinity ffi fl fi', 32, 'Noto Sans JP')).toBeCloseTo(283.168, 9);
    expect(measureTextWidth('日本語 ffi affinity office', 32, 'IBM Plex Mono')).toBeCloseTo(333.28, 9);
    const broken = textLayout(createElement('text', { w: 11, style: { fontSize: 32, fontFamily: 'IBM Plex Mono' }, props: { text: '日fffi', align: 'left', autoSize: false } }));
    expect(broken.lines.map(line => line.text)).toEqual(['日', 'f', 'f', 'f', 'i']);
    expect(broken.lines.slice(1).map(line => line.width)).toEqual([10.4, 10.4, 10.4, 8.8]);
  });

  it('wraps using fallback metrics while retaining source caret offsets and explicit SVG runs', () => {
    const source = '日本語 WWWWWW\nWWWW';
    const element = createElement('text', { w: 120, style: { fontSize: 32, fontFamily: 'IBM Plex Mono' }, props: { text: source, align: 'left', autoSize: false } });
    const layout = textLayout(element);
    expect(layout.lines.map(line => line.text)).toEqual(['日本語', 'WWWW', 'WW', 'WWWW']);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(120);
    for (let i = 0; i <= source.length; i++) expect(layout.renderedToSource[layout.sourceToRendered[i]!]).toBe(i);
    const svg = documentToSvg([element]);
    expect(svg.match(/font-family="Noto Sans JP"/g)).toHaveLength(4);
    expect(svg).toContain('WWWW</tspan>');
  });

  it('uses raw final glyph advance and explicit GPOS offsets for Japanese punctuation', () => {
    const text = 'カタカナ。ひらがな、日本語！';
    // Troika Typesetter ends at glyph.x + raw advance, not the parser's final pen.
    expect(measureTextWidth(text, 32)).toBeCloseTo(406.4, 8);
    const spans = positionFontRuns(text, 32);
    expect(spans.map(span => span.text).join('')).toBe(text);
    expect(spans.at(-1)!.x + 32).toBeCloseTo(406.4, 8);
    expect(spans.find(span => span.text === 'ひ')!.x).toBe(142.4);
  });
});
