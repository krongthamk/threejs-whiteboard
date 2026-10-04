import { expect, it } from 'vitest';
import { createElement, documentToSvg, textBlock, textLayout } from '../src/index.js';

const legacy = [
  createElement('rect', { id: 'empty-rect', index: 'a0', x: 10, y: 20, w: 200, h: 120 }),
  createElement('ellipse', { id: 'empty-ellipse', index: 'a1', x: 240, y: 20, w: 160, h: 80 }),
  createElement('sticky', { id: 'legacy-sticky', index: 'a2', x: 10, y: 180, style: { fontFamily: 'IBM Plex Mono', fontSize: 20 }, props: { text: 'old 日本語\nsecond', align: 'right', autoSize: false } }),
  createElement('text', { id: 'legacy-text', index: 'a3', x: 240, y: 180, rotation: .2, props: { text: '<existing> & text', align: 'center', autoSize: false } }),
];
it('retains the exact pre-shape-label SVG serialization for legacy elements', () => {
  expect(documentToSvg(legacy, { title: 'Legacy & shapes', background: null, fonts: [{ family: 'Inter', dataUrl: 'data:font/woff;base64,AA==' }] })).toMatchInlineSnapshot(`"<svg xmlns="http://www.w3.org/2000/svg" width="448.3388" height="370" viewBox="-15 -5 448.3388 370" role="img"><title>Legacy &amp; shapes</title><defs><style>@font-face{font-family:&apos;Inter&apos;;src:url(&apos;data:font/woff;base64,AA==&apos;);font-weight:400;}</style></defs><g data-element-id="empty-rect" opacity="1"><rect x="10" y="20" width="200" height="120" fill="#ffffff" stroke="#334155" stroke-width="2"/></g><g data-element-id="empty-ellipse" opacity="1"><ellipse cx="320" cy="60" rx="80" ry="40" fill="#ffffff" stroke="#334155" stroke-width="2"/></g><g data-element-id="legacy-sticky" opacity="1"><rect x="10" y="180" width="200" height="160" rx="6" fill="#fff0a8" stroke="#334155" stroke-width="2"/><text x="198" y="212" fill="#172033" font-family="&apos;IBM Plex Mono&apos;, &apos;Noto Sans JP&apos;" font-size="20" text-anchor="start" xml:space="preserve"><tspan data-text-line="0" x="90" y="212"><tspan x="90" font-family="IBM Plex Mono">old </tspan><tspan x="138" font-family="Noto Sans JP">日本語</tspan></tspan><tspan data-text-line="1" x="131.18" y="237"><tspan x="131.18" font-family="Noto Sans JP">second</tspan></tspan></text></g><g data-element-id="legacy-text" opacity="1" transform="rotate(11.4592 320 230)"><text x="320" y="204" fill="#172033" font-family="&apos;Inter&apos;, &apos;Noto Sans JP&apos;" font-size="24" text-anchor="start" xml:space="preserve"><tspan data-text-line="0" x="249.2188" y="204"><tspan x="249.2188" font-family="Inter">&lt;existing&gt; &amp;</tspan></tspan><tspan data-text-line="1" x="298.7539" y="234"><tspan x="298.7539" font-family="Inter">text</tspan></tspan></text></g></svg>"`);
});
it.each(['rect', 'ellipse'] as const)('serializes %s labels after fill with inset clipping and all vertical alignments', type => {
  for (const verticalAlign of ['top', 'middle', 'bottom'] as const) {
    const element = createElement(type, { id: `label-${verticalAlign}`, x: 40, y: 30, w: 240, h: 160, style: { fontSize: 24 }, props: { text: 'Label 日本語', align: 'right', autoSize: false, verticalAlign } });
    const svg = documentToSvg([element], { padding: 0 }), block = textBlock(element)!, layout = textLayout(element);
    expect(svg).toContain('Label'); expect(svg).toContain('日本語');
    expect(svg).toContain('clipPathUnits="userSpaceOnUse"');
    expect(svg).toMatch(/<clipPath id="shape-label-clip-\d+"/);
    expect(svg.indexOf('<text')).toBeGreaterThan(svg.indexOf(type === 'rect' ? '<rect' : '<ellipse'));
    const text = svg.match(/<text x="([\d.-]+)" y="([\d.-]+)"/)!;
    expect(Number(text[1])).toBeCloseTo(element.x + element.w - block.insetX, 4);
    expect(Number(text[2])).toBeCloseTo(element.y + block.insetY + layout.verticalOffset! + element.style.fontSize, 4);
    const clip = svg.match(/<clipPath[^>]*><rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/)!;
    expect(Number(clip[1])).toBeCloseTo(element.x + block.insetX, 4); expect(Number(clip[2])).toBeCloseTo(element.y + block.insetY, 4);
    expect(Number(clip[3])).toBeCloseTo(element.w - block.insetX * 2, 4); expect(Number(clip[4])).toBeCloseTo(element.h - block.insetY * 2, 4);
  }
});
it('uses safe numeric clip IDs and preserves rotation with independent fill and label opacity', () => {
  const shape = createElement('rect', { id: 'unsafe #"<>', rotation: .3, style: { opacity: .6 }, props: { text: 'rotated', align: 'center', autoSize: false, verticalAlign: 'middle' } });
  const svg = documentToSvg([shape, { ...shape, id: 'second', index: 'a1' }]);
  expect(svg).toContain('data-element-id="unsafe #&quot;&lt;&gt;" opacity="1" transform="rotate(');
  expect(svg).toContain('stroke-width="2" opacity="0.6"/>');
  expect(svg).toContain('clip-path="url(#shape-label-clip-0)" opacity="0.6"');
  const ids = [...svg.matchAll(/<clipPath id="([^"]+)"/g)].map(match => match[1]);
  expect(ids).toEqual(['shape-label-clip-0', 'shape-label-clip-1']);
  expect(svg).toContain('clip-path="url(#shape-label-clip-0)"'); expect(svg).toContain('clip-path="url(#shape-label-clip-1)"');
  expect(documentToSvg([shape, { ...shape, id: 'second', index: 'a1' }])).toBe(svg);
});
it('retains overflowing full text and signed offsets while hiding zero-area labels explicitly', () => {
  const shape = createElement('rect', { id: 'overflow', h: 35, style: { fontSize: 32 }, props: { text: 'first\nsecond\nthird', align: 'center', autoSize: false, verticalAlign: 'middle' } });
  const svg = documentToSvg([shape]);
  expect(textLayout(shape).verticalOffset).toBeLessThan(0);
  expect(svg).toContain('first'); expect(svg).toContain('second'); expect(svg).toContain('third'); expect(svg).not.toContain('display="none"');
  const hidden = documentToSvg([{ ...shape, w: 24, h: 24 }]);
  expect(hidden).toContain('display="none"'); expect(hidden.replace(/<[^>]+>/g, '')).toBe('firstsecondthird');
});
