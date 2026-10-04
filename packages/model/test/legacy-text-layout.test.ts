import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveElementGeometry } from '../src/geometry.js';
import { assertValidElement, createElement } from '../src/schema.js';
import { textLayout, textSize } from '../src/text-layout.js';
import type { ElementOf } from '../src/types.js';

type LegacyTextElement = ElementOf<'text'> | ElementOf<'sticky'>;
interface FixtureInput { name: string; element: LegacyTextElement }
interface Provenance {
  capturedCommit: string;
  caseCount: number;
  artifacts: { path: string; sha256: string }[];
}
const fixture = (path: string): string => readFileSync(new URL(`./fixtures/pre-f1-text-layout/${path}`, import.meta.url), 'utf8');
const inputs: FixtureInput[] = JSON.parse(fixture('inputs.json'));
const expectedBytes = fixture('expected.json');
const provenance: Provenance = JSON.parse(fixture('provenance.json'));
const immutableHashes = {
  'inputs.json': 'ea06d37bd27ae05c0ab552d3d4b15c4fe38006e3e74d4c4606e2f09469f820c8',
  'expected.json': '79c6d4f65c1220367bdf97810b5d35f5152b69d565fdbca079e86c30f144acc1',
};

describe('immutable pre-F1 plain text and sticky layout', () => {
  it('retains the captured inputs, outputs and complete font/alignment/mode matrix', () => {
    expect(provenance.capturedCommit).toBe('d9192fc8e53cc035cb030f6de243b2a08f63cd37');
    expect(provenance.caseCount).toBe(100);
    expect(inputs).toHaveLength(provenance.caseCount);
    expect(new Set(inputs.map(input => input.name)).size).toBe(inputs.length);
    for (const [path, hash] of Object.entries(immutableHashes)) {
      expect(createHash('sha256').update(fixture(path)).digest('hex'), path).toBe(hash);
      expect(provenance.artifacts.find(artifact => artifact.path === path)?.sha256, path).toBe(hash);
    }
    const matrix = inputs.filter(input => input.name.startsWith('matrix-'));
    expect(matrix).toHaveLength(36);
    for (const fontFamily of ['Inter', 'IBM Plex Mono', 'Noto Sans JP']) {
      for (const align of ['left', 'center', 'right']) {
        for (const type of ['text', 'sticky']) {
          for (const autoSize of [false, true]) {
            expect(matrix.filter(({ element }) => element.style.fontFamily === fontFamily
              && element.props.align === align && element.type === type && element.props.autoSize === autoSize)).toHaveLength(1);
          }
        }
      }
    }
  });

  it('matches text size, complete layout/caret maps, derived geometry and creation byte for byte', () => {
    const actual = inputs.map(({ name, element }) => {
      assertValidElement(element);
      return {
        name,
        textSize: textSize(element.props.text, element.style.fontSize, element.style.fontFamily),
        textLayout: textLayout(element),
        derivedGeometry: deriveElementGeometry(element),
        createdElement: createElement(element.type, element),
      };
    });
    // Expected bytes are checked in once, before F1. Never write/regenerate them here.
    expect(JSON.stringify(actual, null, 2) + '\n').toBe(expectedBytes);
  });

  it('preserves every original UTF-16 caret and consumes only separator characters', () => {
    for (const { name, element } of inputs) {
      const source = element.props.text;
      const layout = textLayout(element);
      expect(layout.sourceToRendered, name).toHaveLength(source.length + 1);
      expect(layout.renderedToSource, name).toHaveLength(layout.text.length + 1);
      for (let at = 0; at <= source.length; at++) {
        const rendered = layout.sourceToRendered[at]!;
        expect(Number.isInteger(rendered), `${name}: ${at}`).toBe(true);
        expect(layout.renderedToSource[rendered], `${name}: ${at}`).toBe(at);
        if (at) expect(rendered, `${name}: ${at}`).toBeGreaterThanOrEqual(layout.sourceToRendered[at - 1]!);
        if (at < source.length && !layout.lines.some(line => line.start <= at && line.end > at)) {
          expect(source[at], `${name}: ${at}`).toMatch(/[ \t\n]/u);
        }
      }
      for (const line of layout.lines) expect(line.text, name).toBe(source.slice(line.start, line.end));
    }
  });
});
