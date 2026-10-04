import { expect, test } from '@playwright/test';
import { createElement, textLayout, type TextLayout } from '@whiteboard/model';

const fixtures = [
  { id: 'flag', source: '🇺🇸🇯🇵X', w: 1, lines: ['🇺🇸', '🇯🇵', 'X'] },
  { id: 'hangul', source: '가나X', w: 1, lines: ['가', '나', 'X'] },
  { id: 'combining-zwj', source: 'e\u0301👩🏽‍💻1\uFE0F\u20E3X', w: 1, lines: ['e\u0301', '👩🏽‍💻', '1\uFE0F\u20E3', 'X'] },
  { id: 'japanese-latin', source: '日本語ABC', w: 1, lines: ['日', '本', '語', 'A', 'B', 'C'] },
  { id: 'crlf', source: 'A\r\nB', w: 1, lines: ['A', '\r', 'B'] },
  { id: 'space-mark', source: 'A \u0301B', w: 20, lines: ['A', '\u0301B'] },
].map((fixture, i) => {
  const element = createElement('text', { id: fixture.id, x: -250 + i * 100, y: -100, w: fixture.w, h: 200, props: { text: fixture.source, align: 'left', autoSize: false } });
  return { ...fixture, element, layout: textLayout(element), segments: [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(fixture.source)].map(({ segment }) => segment) };
});

test('native renderer and Node share flag, Hangul and ordinary UTF-16 grapheme layouts', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const actual = await page.evaluate(fixtures => {
    const { board, renderer } = window.whiteboard;
    for (const { element } of fixtures) board.add(element);
    renderer.render(false);
    const handles = Reflect.get(renderer, 'textHandles') as Map<string, { layout: TextLayout }>;
    const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
    return fixtures.map(({ id, source }) => ({ id, source: board.read(id)!.props,
      text: renderer.getTextObject(id)!.text, layout: handles.get(id)!.layout,
      segments: [...segmenter.segment(source)].map(({ segment }) => segment) }));
  }, fixtures);
  for (const [i, row] of actual.entries()) {
    const fixture = fixtures[i]!;
    expect(row.text).toBe(fixture.lines.join('\n'));
    expect(row.layout).toEqual(fixture.layout);
    expect(row.source).toMatchObject({ text: fixture.source });
    expect(row.segments).toEqual(fixture.segments);
    for (let at = 0; at <= fixture.source.length; at++) expect(row.layout.renderedToSource[row.layout.sourceToRendered[at]!]).toBe(at);
  }
  expect(errors).toEqual([]);
});
