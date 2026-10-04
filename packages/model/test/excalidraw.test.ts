import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertValidElement, importExcalidraw, isWellFormedString, resolveBinding, rotatePoint, MAX_COORDINATE, MAX_EXCALIDRAW_BYTES, MAX_FONT_SIZE, MAX_IMAGE_BYTES, MAX_IMPORT_ELEMENTS, MAX_TEXT_LENGTH, type ExcalidrawImport } from '../src/index.js';
import { jpegHeader, pngHeader, webpHeader } from '../../../tests/image-fixtures';

type Raw = Record<string, unknown>;
const raw = (id: string, type = 'rectangle', changes: Raw = {}): Raw => ({ id, type, x: 0, y: 0, width: 100, height: 60, angle: 0,
  strokeColor: '#123456', backgroundColor: '#ffffff', opacity: 100, strokeWidth: 2, roughness: 0, fillStyle: 'solid', strokeStyle: 'solid', ...changes });
const label = (id: string, changes: Raw = {}) => raw(id, 'text', { text: 'wrapped\nLabel', originalText: 'Label', containerId: 'container', fontFamily: 2, fontSize: 20, textAlign: 'center', verticalAlign: 'middle', ...changes });
const document = (elements: Raw[], extra: Raw = {}) => ({ type: 'excalidraw', version: 2, elements, ...extra });
function convert(json: unknown, firstIndex: string | null = null): ExcalidrawImport {
  let id = 0; return importExcalidraw(json, { newId: () => 'native-' + ++id, firstIndex });
}
const textElements = (result: ExcalidrawImport) => result.elements.filter(element => element.type === 'text');
const dataURL = (mime: string, bytes: Uint8Array) => 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');

describe('strict converter identity and label regressions', () => {
  it('rejects an array-coerced envelope type rather than accepting it as a clipboard', () => {
    expect(() => convert({ type: ['excalidraw'], elements: [] })).toThrow('Invalid Excalidraw import');
  });
  it('treats a caller allocator exception as fatal, not a skipped input element', () => {
    expect(() => importExcalidraw(document([raw('r')]), { firstIndex: null, newId: () => { throw new Error('allocator failure'); } })).toThrow('Invalid Excalidraw import');
  });
  it('does not reuse a deleted source ID and skips live/deleted duplicate ambiguity', () => {
    expect(() => importExcalidraw(document([raw('old', 'rectangle', { isDeleted: true }), raw('live')]), { firstIndex: null, newId: () => 'old' })).toThrow('fresh unique');
    const result = convert(document([raw('duplicate', 'rectangle', { isDeleted: true }), raw('duplicate'), raw('survivor')]));
    expect(result.elements).toHaveLength(1); expect(result.report.skipped).toEqual([{ id: 'duplicate', type: 'rectangle', reason: 'duplicate source ID is ambiguous' }]);
  });
  it('preserves an invisible bound label without painting it black inside its visible container', () => {
    const result = convert(document([raw('container'), label('label', { strokeColor: 'transparent' })]));
    expect(result.elements).toHaveLength(2); expect(result.elements[0]!.props).toEqual({});
    expect(textElements(result)[0]).toMatchObject({ style: { opacity: 0 }, props: { text: 'Label' } });
    expect(result.report.substituted.some(reason => reason.includes('label') && reason.includes('free text'))).toBe(true);
  });
  it.each(['frame', 'magicframe'])('keeps a %s name and preserves a frame-target label as reported free text', type => {
    const result = convert(document([raw('container', type, { name: 'Frame name' }), label('label')]));
    expect(result.elements[0]!.props).toMatchObject({ text: 'Frame name' });
    expect(textElements(result)[0]!.props).toMatchObject({ text: 'Label' });
    expect(result.report.substituted.some(reason => reason.includes('label') && reason.includes('free text'))).toBe(true);
  });
});

describe('Excalidraw mappings and source preservation', () => {
  it('converts the explicitly synthetic every-type fixture without mutating source or losing source text', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/excalidraw/synthetic-every-type.json', import.meta.url), 'utf8'));
    const before = structuredClone(fixture), result = convert(fixture, 'b10');
    expect(result.elements.map(e => e.type)).toEqual(['rect', 'ellipse', 'rect', 'text', 'stroke', 'stroke', 'connector', 'connector', 'connector', 'image', 'rect', 'rect']);
    expect(result.report.imported).toBe(12);
    expect(result.report.skipped.map(s => s.type)).toEqual(['embeddable', 'iframe', 'stickynote', 'future-type']);
    expect(result.report.skipped.every(s => s.reason === 'unsupported element type')).toBe(true);
    expect(result.elements[0]).toMatchObject({ x: 20, y: 30, w: 120, h: 80, style: { fill: '#dbe9ff', fontFamily: 'Inter', color: '#123456' },
      props: { text: '  Shape 日本語 \n\n', align: 'center', autoSize: false, verticalAlign: 'middle' } });
    expect(result.elements[3]).toMatchObject({ style: { fontFamily: 'IBM Plex Mono', fontSize: 18 }, props: { text: 'Mono \t\ntext\n', align: 'right', autoSize: false } });
    expect(result.elements[6]).toMatchObject({ props: { kind: 'straight', start: { elementId: result.elements[0]!.id }, end: { elementId: result.elements[1]!.id } } });
    expect(result.elements[7]).toMatchObject({ props: { kind: 'curve' } }); expect(result.elements[8]).toMatchObject({ props: { kind: 'elbow' } });
    expect(result.elements[10]).toMatchObject({ style: { fill: 'none' }, props: { text: 'Planning' } }); expect(result.elements[11]!.props).toEqual({});
    expect(result.images).toHaveLength(1); expect(result.images[0]).toMatchObject({ elementId: result.elements[9]!.id, naturalW: 1, naturalH: 1, mimeType: 'image/png' });
    expect(new Set(result.elements.map(e => e.id)).size).toBe(12);
    result.elements.forEach((e, i) => { assertValidElement(e); expect(fixture.elements.some((s: Raw) => s.id === e.id)).toBe(false); expect(e.index > (i ? result.elements[i - 1]!.index : 'b10')).toBe(true); });
    expect(result.report.substituted).toEqual(expect.arrayContaining(['Virgil substituted with Inter', 'Cascadia substituted with IBM Plex Mono', '1 group(s) dropped', 'Hatched/pattern fills replaced with solid fills']));
    expect(new Set(result.report.substituted).size).toBe(result.report.substituted.length); expect(fixture).toEqual(before);
    expect(convert(fixture, 'b10')).toEqual(result);
  });

  it('keeps array stacking across labels-before-container, duplicate IDs, deleted and malformed elements', () => {
    const result = convert(document([label('early'), raw('container'), raw('duplicate'), raw('middle', 'ellipse'),
      raw('duplicate'), raw('deleted', 'rectangle', { isDeleted: true }), label('second', { originalText: 'Second' }), raw('bad', 'rectangle', { x: NaN })]));
    expect(result.elements.map(e => e.type)).toEqual(['rect', 'ellipse', 'text']);
    expect(result.elements[0]!.props).toMatchObject({ text: 'Label' }); expect(result.elements[2]!.props).toMatchObject({ text: 'Second' });
    expect(result.report.skipped.map(e => e.id)).toEqual(['duplicate', 'duplicate', 'bad']);
    expect(result.report.substituted.some(reason => reason.includes('second') && reason.includes('free text'))).toBe(true);
  });

  it.each(['frame', 'magicframe'])('imports unnamed %s and preserves trailing name whitespace', type => {
    const result = convert(document([raw('null', type, { name: null }), raw('absent', type), raw('named', type, { name: '  Name\n\n' })]));
    expect(result.elements.map(e => e.props)).toEqual([{}, {}, { text: '  Name\n\n', autoSize: false, align: 'left', verticalAlign: 'top' }]);
  });

  it('preserves orphan/arrow labels as free text, invalid present originalText as a skip, and empty labels as canonical props', () => {
    const result = convert(document([raw('container'), label('invalid', { originalText: 42 }), label('empty', { originalText: '' }),
      label('orphan', { containerId: 'missing', originalText: '\n Source  \n' }), raw('arrow', 'arrow', { points: [[0, 0], [80, 40]] }), label('arrow-label', { containerId: 'arrow' })]));
    expect(result.report.skipped.map(e => e.id)).toEqual(['invalid']); expect(result.elements[0]!.props).toEqual({});
    expect(textElements(result).map(e => e.props.text)).toEqual(['\n Source  \n', 'Label']);
    expect(result.report.substituted.filter(reason => reason.includes('free text'))).toHaveLength(4); // orphan/arrow binding + their non-top alignment
    expect(convert(document([label('legacy', { originalText: undefined, text: 'Legacy\ntext', containerId: null })])).elements[0]!.props).toMatchObject({ text: 'Legacy\ntext' });
  });

  it('does not report paint losses for invisible-only shapes and strokes, but retains semantic losses', () => {
    const result = convert(document([raw('invisible', 'rectangle', { backgroundColor: 'transparent', strokeColor: 'transparent', roughness: 1, fillStyle: 'hachure', strokeStyle: 'dashed', locked: true }),
      raw('invisible-line', 'line', { points: [[0, 0], [80, 40]], strokeColor: 'transparent', roughness: 1, strokeStyle: 'dotted' }),
      raw('zero-width', 'freedraw', { points: [[0, 0], [80, 40]], strokeWidth: 0, roughness: 1, strokeStyle: 'dashed' })]));
    expect(result.report.substituted).toEqual(['invisible: element lock dropped']);
  });

  it('does not report substitutions from rejected elements or hatch/roughness paint that was never visible', () => {
    const result = convert(document([label('bad-font', { containerId: null, fontFamily: 8, fontSize: -2 }),
      raw('invisible', 'rectangle', { backgroundColor: 'transparent', strokeColor: 'transparent', roughness: 1, fillStyle: 'hachure' }),
      raw('visible', 'ellipse', { backgroundColor: '#fff', roughness: 1, fillStyle: 'hachure' })]));
    expect(result.report.skipped).toHaveLength(1); expect(result.report.substituted.some(s => s.includes('Comic Shanns'))).toBe(false);
    expect(result.report.substituted.filter(s => s.includes('roughness'))).toHaveLength(1);
    expect(result.report.substituted.filter(s => s.includes('Hatched'))).toHaveLength(1);
  });
});

describe('safe colors and relevant styles', () => {
  it.each([
    ['#abc', '#aabbcc'], [' RED ', '#ff0000'], ['rebeccapurple', '#663399'], ['lightgrey', '#d3d3d3'],
    ['rgb(12, 34, 56)', '#0c2238'], ['rgb(100%, 50%, 0%)', '#ff8000'], ['rgba(0,255,0,1)', '#00ff00'],
    ['hsl(240,100%,50%)', '#0000ff'], ['hsl(720, 0%, 50%)', '#808080'], ['hsla(120,100%,50%,1)', '#00ff00'],
    ['#123f', '#112233'], ['#123456ff', '#123456'],
  ])('canonicalizes opaque %s identically for model renderer/export consumers', (input, expected) => {
    expect(convert(document([raw('color', 'rectangle', { backgroundColor: input })])).elements[0]!.style.fill).toBe(expected);
  });
  it.each(['transparent', 'none', '#1230', '#12345600', 'rgba(1,2,3,0)', 'hsla(90,10%,20%,0)'])('preserves %s transparent background as fill none', input => {
    expect(convert(document([raw('color', 'rectangle', { backgroundColor: input })])).elements[0]!.style.fill).toBe('none');
  });
  it.each(['rgba(0,0,0,.5)', 'hsla(0,0%,0%,.2)', '#ff000080', '#1234', 'rgb(256,0,0)', 'rgb(100%,0,0)', 'rgb(0 0 0)', 'hsl(0,101%,50%)', 'var(--color)', 'currentColor', 'rgb(0,0,0)junk'])('reports unsupported visible color %s without silently defaulting', input => {
    const result = convert(document([raw('invalid', 'rectangle', { backgroundColor: input }), raw('good')]));
    expect(result.elements).toHaveLength(1); expect(result.report.skipped[0]).toMatchObject({ id: 'invalid' });
    expect(result.report.substituted).toEqual([]);
  });
  it('ignores irrelevant background colors for text/strokes/images and preserves representable transparent strokes', () => {
    const result = convert(document([label('text', { containerId: null, backgroundColor: 'rgba(0,0,0,.5)' }),
      raw('line', 'line', { points: [[0, 0], [20, 20]], strokeColor: 'transparent', backgroundColor: 'not-a-color' }),
      raw('shape', 'rectangle', { strokeColor: '#12345600', backgroundColor: '#ff0000' })]));
    expect(result.report.skipped).toEqual([]); expect(result.elements[1]!.style.opacity).toBe(0);
    expect(result.elements[2]!.style).toMatchObject({ fill: '#ff0000', strokeWidth: 0, opacity: 1 });
  });
});

describe('point geometry and bindings', () => {
  it('keeps valid legacy focus/gap target bindings when fixedPoint is explicitly null', () => {
    // Legacy exported bindings use null for the optional fixed point (Excalidraw issue 8995).
    const result = convert(document([raw('target'), raw('arrow', 'arrow', { points: [[0, 30], [120, 30]],
      startBinding: { elementId: 'target', focus: 0, gap: 0, fixedPoint: null },
      endBinding: { elementId: 'target', focus: .5, gap: 8, fixedPoint: null } })]));
    const arrow = result.elements[1]!; if (arrow.type !== 'connector') throw new Error('connector');
    expect(arrow.props.start).toMatchObject({ elementId: result.elements[0]!.id });
    expect(arrow.props.end).toMatchObject({ elementId: result.elements[0]!.id });
    expect(result.report.substituted.some(s => s.includes('metadata was malformed'))).toBe(false);
  });
  it('bakes freehand rotation about point bounds with exact source pressure and rejects invalid derived world extents', () => {
    const source = raw('ink', 'freedraw', { x: 100, y: 50, width: 100, height: 20, angle: Math.PI / 2, points: [[0, 0], [-100, -20]], pressures: [.2, .8] });
    const result = convert(document([source])); expect(result.elements[0]).toMatchObject({ type: 'stroke', rotation: 0 });
    const element = result.elements[0]!; if (element.type !== 'stroke') throw new Error('stroke');
    const center = { x: 50, y: 40 }, first = rotatePoint({ x: 100, y: 50 }, center, Math.PI / 2), last = rotatePoint({ x: 0, y: 30 }, center, Math.PI / 2);
    expect(element.props.points).toEqual([first.x, first.y, .2, last.x, last.y, .8]);
    const bad = convert(document([raw('overflow', 'freedraw', { points: [[-MAX_COORDINATE, 0], [MAX_COORDINATE, 0]] })]));
    expect(bad.elements).toEqual([]); expect(bad.report.skipped).toHaveLength(1);
  });
  it('inverse-rotates carried endpoints for a bound target and keeps original fallback plus native follow behavior', () => {
    const target = raw('target', 'rectangle', { x: 20, y: 30, width: 100, height: 60, angle: Math.PI / 2 });
    const point = rotatePoint({ x: 120, y: 60 }, { x: 70, y: 60 }, Math.PI / 2);
    const result = convert(document([raw('arrow', 'arrow', { x: point.x, y: point.y, points: [[0, 0], [100, 0]],
      startBinding: { elementId: 'target', focus: 0, gap: 0 }, endBinding: { elementId: 'missing', fixedPoint: [0, .5], mode: 'inside' } }), target]));
    const [arrow, shape] = result.elements;
    if (arrow?.type !== 'connector') throw new Error('connector');
    expect(arrow.props.start).toMatchObject({ elementId: shape!.id, nx: 1, ny: .5, fallback: point });
    expect(resolveBinding(arrow.props.start, new Map([[shape!.id, shape!]]))).toEqual(point);
    expect(resolveBinding(arrow.props.start, new Map([[shape!.id, { ...shape!, x: shape!.x + 40, y: shape!.y - 7 }]]))).toEqual({ x: point.x + 40, y: point.y - 7 });
    expect(arrow.props.end).toEqual({ x: point.x + 100, y: point.y });
    expect(result.report.substituted.some(s => s.includes('missing') || s.includes('target was missing'))).toBe(true);
  });
  it.each([
    { elementId: 'target', focus: .4, gap: 12 },
    { elementId: 'target', fixedPoint: [1, .5], mode: 'orbit' },
    { elementId: 'target', fixedPoint: [1, .5], mode: 'skip' },
  ])('reports legacy/modern clamped binding loss for %j', startBinding => {
    const result = convert(document([raw('target'), raw('arrow', 'arrow', { x: 120, y: 30, points: [[0, 0], [80, 0]], startBinding })]));
    const arrow = result.elements[1]!; if (arrow.type !== 'connector') throw new Error('connector');
    expect(arrow.props.start).toMatchObject({ elementId: result.elements[0]!.id, nx: 1, fallback: { x: 120, y: 30 } });
    expect(result.report.substituted.some(s => s.includes('projected'))).toBe(true);
    expect(result.report.substituted.some(s => s.includes('behavior replaced'))).toBe(true);
  });
  it('keeps malformed binding metadata and zero-area/deleted targets as reportable point endpoints', () => {
    const result = convert(document([raw('zero', 'ellipse', { width: 0 }), raw('deleted', 'rectangle', { isDeleted: true }),
      raw('a', 'arrow', { points: [[0, 0], [20, 20]], startBinding: { elementId: 'zero' }, endBinding: { elementId: 'deleted' } }),
      raw('b', 'arrow', { points: [[0, 0], [30, 30]], startBinding: { elementId: 'target', mode: ['inside'] } }), raw('target')]));
    const a = result.elements[1]!, b = result.elements[2]!;
    if (a.type !== 'connector' || b.type !== 'connector') throw new Error('connector');
    expect(a.props.start).toEqual({ x: 0, y: 0 }); expect(a.props.end).toEqual({ x: 20, y: 20 }); expect(b.props.start).toEqual({ x: 0, y: 0 });
  });
});

describe('image admission and pure transform descriptors', () => {
  it.each([
    ['image/png', pngHeader(80, 60), 80, 60], ['image/jpeg', jpegHeader(80, 60, 6), 60, 80], ['image/webp', webpHeader(80, 60, 'VP8L'), 80, 60],
  ] as const)('reads bounded %s headers and carries original bytes without pretending to decode pixels', (mime, bytes, width, height) => {
    const result = convert(document([raw('image', 'image', { fileId: 'file' })], { files: { file: { mimeType: mime, dataURL: dataURL(mime, bytes) } } }));
    expect(result.images[0]).toMatchObject({ mimeType: mime, naturalW: width, naturalH: height, bytes });
    expect(result.elements[0]).toMatchObject({ props: { assetId: 'import-pending', naturalW: width, naturalH: height } });
    expect(result.images[0]!.transform).toBeUndefined();
  });
  it('keeps shared bytes and independent crop/flip metadata, using oriented source coordinates', () => {
    const bytes = jpegHeader(80, 60, 6), file = { mimeType: 'image/jpeg', dataURL: dataURL('image/jpeg', bytes) };
    const result = convert(document([raw('normal', 'image', { fileId: 'file', crop: null }), raw('flipped', 'image', { fileId: 'file', scale: [-1, 1],
      crop: { x: 10.5, y: 20, width: 40, height: 50, naturalWidth: 60, naturalHeight: 80 } }), raw('double', 'image', { fileId: 'file', scale: [-1, -1] })], { files: { file } }));
    expect(result.images[0]!.bytes).toBe(result.images[1]!.bytes);
    expect(result.images[1]!.transform).toEqual({ flipX: true, flipY: false, crop: { x: 10.5, y: 20, width: 40, height: 50 } });
    expect(result.images[2]!.transform).toEqual({ flipX: true, flipY: true });
    expect(result.elements[1]).toMatchObject({ x: 0, y: 0, w: 100, h: 60 });
    expect(result.report.substituted).toEqual([]);
  });
  it.each([
    { scale: null }, { scale: [1, 0] }, { scale: [-1] }, { crop: { x: -1, y: 0, width: 10, height: 10 } },
    { crop: { x: 50, y: 0, width: 40, height: 10 } }, { crop: { x: 0, y: 0, width: 0, height: 10 } },
  ])('reports malformed image transform %j without a dangling payload', changes => {
    const result = convert(document([raw('bad', 'image', { fileId: 'file', ...changes }), raw('good')], { files: { file: { dataURL: dataURL('image/png', pngHeader(80, 60)) } } }));
    expect(result.elements).toHaveLength(1); expect(result.images).toEqual([]); expect(result.report.skipped).toHaveLength(1); expect(result.report.substituted).toEqual([]);
  });
  it('reports missing/mismatched/refused image files and unsafe dimensions without decoding unused files', () => {
    for (const file of [undefined, { dataURL: 'data:image/svg+xml;base64,PHN2Zy8+' }, { dataURL: 'data:image/gif;base64,R0lGODlh' }, { dataURL: 'data:image/png;base64,!!!!' },
      { dataURL: dataURL('image/png', jpegHeader(10, 10)) }, { dataURL: dataURL('image/png', pngHeader(16385, 1)) },
      { dataURL: dataURL('image/png', pngHeader(10001, 10000)) }, { mimeType: 'image/jpeg', dataURL: dataURL('image/png', pngHeader(10, 10)) }]) {
      const result = convert(document([raw('image', 'image', { fileId: 'file' }), raw('good')], { files: { file, unused: { dataURL: 'bad' } } }));
      expect(result.elements).toHaveLength(1); expect(result.images).toEqual([]); expect(result.report.skipped[0]!.id).toBe('image');
    }
  });
});

describe('global admission versus independent malformed elements', () => {
  it('bounds repeated warning ID prefixes at UTF16 boundaries without conflating long IDs', () => {
    const prefix = 'a'.repeat(127) + '😀' + 'x'.repeat(32_000);
    const result = convert(document([raw(prefix + '1', 'arrow', { points: [[0, 0], [20, 20], [40, 0]], startArrowhead: 'bar' }),
      raw(prefix + '2', 'arrow', { points: [[0, 0], [20, 20], [40, 0]], startArrowhead: 'bar' }), raw(prefix + '3', 'rectangle', { width: -1 })]));
    expect(result.report.substituted.every(s => s.length < 220 && isWellFormedString(s))).toBe(true);
    expect(result.report.substituted.filter(s => s.includes('curve routing'))).toHaveLength(2);
    expect(result.report.substituted.some(s => s.includes('(element 1)'))).toBe(true);
    expect(result.report.substituted.some(s => s.includes('(element 2)'))).toBe(true);
    expect(result.report.skipped[0]!.id).toBe(prefix + '3');
  });
  it('supports file and clipboard envelopes but rejects invalid options and counts before allocation/decoding', () => {
    expect(convert({ type: 'excalidraw/clipboard', elements: [raw('shape')] }).report.imported).toBe(1);
    for (const json of [null, {}, document([], { version: 1 }), { type: 'excalidraw', version: 2, elements: {} }]) expect(() => convert(json)).toThrow('Invalid Excalidraw import');
    for (const maximum of [0, -1, MAX_IMPORT_ELEMENTS + 1, 1.5, null]) expect(() => importExcalidraw(document([]), { newId: () => 'new', firstIndex: null, maxElements: maximum as number })).toThrow('maxElements');
    expect(() => importExcalidraw(document([]), { newId: () => 'new', firstIndex: 'not-an-index' })).toThrow('firstIndex');
    expect(() => convert(document(Array.from({ length: MAX_IMPORT_ELEMENTS + 1 }, () => raw('same'))))).toThrow('element count');
    expect(() => convert(document(Array.from({ length: 101 }, (_, i) => raw('image' + i, 'image'))))).toThrow('image count');
    expect(() => importExcalidraw(document([raw('a'), raw('b')]), { firstIndex: null, newId: () => 'same' })).toThrow('fresh unique');
    expect(() => importExcalidraw(document([raw('a')]), { firstIndex: null, newId: () => '\ud800' })).toThrow('fresh unique');
  });
  it('keeps unrelated elements when a JSON-valid element has invalid values or identity', () => {
    const bad: Raw[] = [raw('coord', 'rectangle', { x: MAX_COORDINATE + 1 }), raw('size', 'rectangle', { width: -1 }),
      label('font', { fontSize: MAX_FONT_SIZE + 1 }), label('surrogate', { originalText: '\ud800' }), label('long', { originalText: 'x'.repeat(MAX_TEXT_LENGTH + 1) }),
      raw('pressure', 'freedraw', { points: [[0, 0], [2, 2]], pressures: [2, .5] }), raw('points', 'line', { points: [[0, 0], [1, null]] }),
      raw('id\ud800'), { id: 'missing-type' }];
    const result = convert(document([...bad, raw('valid')]));
    expect(result.elements).toHaveLength(1); expect(result.report.skipped).toHaveLength(bad.length); expect(result.report.substituted).toEqual([]);
  });
  it('preflights the source UTF8 byte limit and image decoded-byte estimate', () => {
    expect(() => convert(document([], { metadata: 'x'.repeat(MAX_EXCALIDRAW_BYTES) }))).toThrow('50 MiB');
    const multibyte = document([], { metadata: '日'.repeat(Math.floor(MAX_EXCALIDRAW_BYTES / 2)) });
    expect(JSON.stringify(multibyte).length).toBeLessThan(MAX_EXCALIDRAW_BYTES);
    const newId = vi.fn(() => 'fresh');
    expect(() => importExcalidraw(multibyte, { newId, firstIndex: null })).toThrow('50 MiB');
    expect(newId).not.toHaveBeenCalled();
    const image = convert(document([raw('image', 'image', { fileId: 'file' }), raw('survivor')], { files: { file: { dataURL: 'data:image/png;base64,' + 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4) } } }));
    expect(image.elements).toHaveLength(1); expect(image.report.skipped[0]!.reason).toContain('20 MiB');
  });
});

describe('unchanged genuine application/export fixtures', () => {
  it('converts the actual official-app mixed export with both target bindings, full label source and original image bytes', () => {
    const bytes = readFileSync(new URL('./fixtures/excalidraw/official-app-mixed.excalidraw', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('dd49a1f29fefca2a51fee4c5983a570db27688a3fb003d11929a9af12305d55f');
    const fixture = JSON.parse(bytes.toString()), before = structuredClone(fixture), result = convert(fixture);
    expect(bytes).toHaveLength(11_544); expect(result.report.imported).toBe(9); expect(result.report.skipped).toEqual([]);
    expect(result.elements.map(e => e.type)).toEqual(['rect', 'ellipse', 'rect', 'text', 'connector', 'stroke', 'image', 'stroke', 'rect']);
    const rectangle = result.elements[0]!, ellipse = result.elements[1]!, arrow = result.elements[4]!;
    expect(rectangle.props).toMatchObject({ text: 'Bound rectangle\n日本語 label', autoSize: false });
    if (arrow.type !== 'connector') throw new Error('connector');
    expect(arrow.props.start).toMatchObject({ elementId: rectangle.id }); expect(arrow.props.end).toMatchObject({ elementId: ellipse.id });
    const map = new Map(result.elements.map(e => [e.id, e])), start = resolveBinding(arrow.props.start, map), end = resolveBinding(arrow.props.end, map);
    map.set(rectangle.id, { ...rectangle, x: rectangle.x + 25, y: rectangle.y - 8 });
    expect(resolveBinding(arrow.props.start, map)).toEqual({ x: start.x + 25, y: start.y - 8 }); expect(resolveBinding(arrow.props.end, map)).toEqual(end);
    expect(result.images).toHaveLength(1); expect(result.images[0]).toMatchObject({ naturalW: 1, naturalH: 1, transform: { flipX: true, flipY: true } });
    const file = fixture.files[fixture.elements.find((e: Raw) => e.type === 'image').fileId];
    expect(result.images[0]!.bytes).toEqual(new Uint8Array(Buffer.from(file.dataURL.split(',')[1], 'base64')));
    expect(result.elements[8]!.props).toEqual({}); // Actual unnamed frame survives.
    expect(result.report).toEqual({
      "imported": 9,
      "skipped": [],
      "substituted": [
            "Hand-drawn roughness replaced with native geometry",
            "Mvvz2TXWVRnk7mOQY2rJr: roundness dropped",
            "fIo3BfVKxhwqiVgJELmIw: roundness dropped",
            "YxKBvfx2G2OLI_f7FQ2_m: diamond replaced with rectangle",
            "YxKBvfx2G2OLI_f7FQ2_m: roundness dropped",
            "G8UkyWBtHtJa8YJME8h-b: line replaced with native pressure stroke; routing and width may differ",
            "G8UkyWBtHtJa8YJME8h-b: roundness dropped",
            "Pe6uQSqh3fsgG_2n6qlrH: freehand outline replaced with native pressure stroke",
            "Pe6uQSqh3fsgG_2n6qlrH: frame membership and clipping dropped",
            "Z7wFkiZM1-H07-hCs7xfe: frame replaced with transparent rectangle; frame behavior dropped",
            "Excalifont substituted with Inter",
            "7E6z6f9TLJTe7Ux5YYblL: bound label reflow/placement uses native font metrics and shape insets",
            "6jm0dQ6b0vtBaXTUil35A: text dimensions recalculated with native font metrics",
            "aewPn17Wtk9Ppz7gKcOL4: start gapped endpoint projected onto target bounds",
            "aewPn17Wtk9Ppz7gKcOL4: start gap/focus/orbit binding behavior replaced with native normalized binding",
            "aewPn17Wtk9Ppz7gKcOL4: end gapped endpoint projected onto target bounds",
            "aewPn17Wtk9Ppz7gKcOL4: end gap/focus/orbit binding behavior replaced with native normalized binding",
            "aewPn17Wtk9Ppz7gKcOL4: roundness dropped"
      ]
});
    result.elements.forEach(assertValidElement); expect(fixture).toEqual(before);
  });
  it('loads the exact pinned upstream legacy SVG-export payload with absent originalText/files/autoResize fields', () => {
    const bytes = readFileSync(new URL('./fixtures/excalidraw/upstream-legacy-text.excalidraw', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('f7a80231fe0a78f4b996b3373423c42a8fa1dbb0f3086d57d740597c796127a3');
    const fixture = JSON.parse(bytes.toString());
    const result = convert(fixture);
    expect(result.report.imported).toBe(1); expect(result.report.skipped).toEqual([]);
    expect(result.elements[0]).toMatchObject({ type: 'text', props: { text: 'test', align: 'left', autoSize: true }, style: { fontFamily: 'Inter', fontSize: 36 } });
    expect(result.report.substituted).toContain('Virgil substituted with Inter');
  });
});
