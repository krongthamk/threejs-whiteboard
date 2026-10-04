import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory } from '../evidence';

const errors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
const horizontal = 'Horizontal text alignment', vertical = 'Vertical text alignment';
async function select(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(ids => { const app = window.whiteboard; app.session.setState({ tool: 'select', selectedIds: ids }); app.board.undoManager.clear(); }, ids);
}
async function records(page: Page) { return page.evaluate(() => window.whiteboard.board.readAll()); }

test.beforeEach(async ({ page }) => {
  errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const board = window.whiteboard.board;
    board.create('rect', { id: 'rect', x: -160, y: -100, w: 240, h: 160, rotation: .2, props: { text: 'Rectangle text', align: 'center', autoSize: false, verticalAlign: 'middle' } });
    board.create('ellipse', { id: 'ellipse', x: 160, y: -100, w: 240, h: 160, props: { text: 'Ellipse text', align: 'right', autoSize: false, verticalAlign: 'top' } });
    board.create('sticky', { id: 'sticky', x: -160, y: 140, props: { text: 'Sticky text', align: 'left', autoSize: false } });
    board.create('text', { id: 'plain', x: 160, y: 140, props: { text: 'Plain text', align: 'left', autoSize: false } });
    board.create('rect', { id: 'empty', x: 420, y: 140 });
  });
});

for (const id of ['rect', 'ellipse']) test(`${id} label font and all horizontal and vertical controls preserve the box and undo`, async ({ page }, testInfo) => {
  await select(page, [id]);
  await expect(page.getByLabel('Font', { exact: true })).toBeVisible({ timeout: 3000 });
  const before = (await records(page)).find(element => element.id === id)!;
  await page.getByLabel('Font', { exact: true }).selectOption('IBM Plex Mono');
  expect(await page.evaluate(id => window.whiteboard.board.read(id)!.style.fontFamily, id)).toBe('IBM Plex Mono');
  expect(await page.evaluate(() => window.whiteboard.session.getState().style.fontFamily)).toBe('IBM Plex Mono');
  await page.getByLabel('Size', { exact: true }).fill('36'); await page.getByLabel(horizontal, { exact: true }).focus();
  for (const align of ['left', 'center', 'right']) {
    await page.getByLabel(horizontal, { exact: true }).selectOption(align);
    expect(await page.evaluate(id => (() => { const e = window.whiteboard.board.read(id)!; return 'align' in e.props ? e.props.align : undefined; })(), id)).toBe(align);
  }
  for (const align of ['bottom', 'middle', 'top']) {
    await page.getByLabel(vertical, { exact: true }).selectOption(align);
    expect(await page.evaluate(id => (() => { const e = window.whiteboard.board.read(id)!; return 'verticalAlign' in e.props ? e.props.verticalAlign : undefined; })(), id)).toBe(align);
  }
  const after = (await records(page)).find(element => element.id === id)!;
  expect(after).toMatchObject({ x: before.x, y: before.y, w: before.w, h: before.h, rotation: before.rotation, index: before.index, props: { text: 'text' in before.props ? before.props.text : undefined, autoSize: false } });
  expect(after.style).toEqual({ ...before.style, fontFamily: 'IBM Plex Mono', fontSize: 36 });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(8);
  const directory = evidenceDirectory(testInfo); writeFileSync(`${directory}/controls.json`, JSON.stringify({ before, after }, null, 2)); await page.screenshot({ path: `${directory}/controls.png` });
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await records(page)).find(element => element.id === id)).toEqual(before);
});

test('mixed selection alignment batches only eligible text and shape labels into one undo each', async ({ page }) => {
  await select(page, ['empty', 'rect', 'ellipse', 'sticky', 'plain']); const before = await records(page);
  await expect(page.getByLabel(horizontal, { exact: true })).toHaveValue('', { timeout: 3000 });
  await page.getByLabel(horizontal, { exact: true }).selectOption('right');
  await page.getByLabel(vertical, { exact: true }).selectOption('bottom');
  const after = await records(page);
  for (const element of after) {
    const original = before.find(value => value.id === element.id)!;
    if (element.id === 'empty') expect(element).toEqual(original);
    else {
      expect(element.props).toMatchObject({ ...original.props, align: 'right', ...(['rect', 'ellipse'].includes(element.id) ? { verticalAlign: 'bottom' } : {}) });
      expect({ ...element, props: original.props }).toEqual(original);
    }
  }
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await records(page)).toEqual(before);
});

test('empty shapes never gain text through controls and sticky notes retain top alignment', async ({ page }) => {
  await select(page, ['empty']);
  await expect(page.getByLabel('Font', { exact: true })).toHaveCount(0); await expect(page.getByLabel(horizontal, { exact: true })).toHaveCount(0); await expect(page.getByLabel(vertical, { exact: true })).toHaveCount(0);
  await select(page, ['sticky']);
  await expect(page.getByLabel('Font', { exact: true })).toBeVisible(); await expect(page.getByLabel(vertical, { exact: true })).toHaveCount(0);
  await page.getByLabel(horizontal, { exact: true }).selectOption('center');
  const state = await page.evaluate(() => ({ sticky: window.whiteboard.board.read('sticky')!.props, empty: window.whiteboard.board.read('empty')!.props }));
  expect(state.sticky).toEqual({ text: 'Sticky text', align: 'center', autoSize: false }); expect(state.empty).toEqual({});
});

for (const control of ['horizontal', 'vertical', 'font'] as const) test(`clicking ${control} after typing keeps the fresh blur commit and separate undo`, async ({ page }) => {
  await select(page, ['rect']); await page.evaluate(() => window.whiteboard.textEditor.open('rect'));
  const input = page.getByRole('textbox', { name: 'Edit text' }); await expect(input).toBeFocused(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('Freshly committed label');
  const target = page.getByLabel(control === 'horizontal' ? horizontal : control === 'vertical' ? vertical : 'Font', { exact: true });
  // A real focus click triggers native blur before the change action reads props.
  await target.click(); await expect(input).toHaveCount(0);
  await target.selectOption(control === 'horizontal' ? 'right' : control === 'vertical' ? 'bottom' : 'IBM Plex Mono');
  const current = await page.evaluate(() => window.whiteboard.board.read('rect')!);
  expect(current.props).toMatchObject({ text: 'Freshly committed label', ...(control === 'horizontal' ? { align: 'right' } : control === 'vertical' ? { verticalAlign: 'bottom' } : {}) });
  if (control === 'font') expect(current.style.fontFamily).toBe('IBM Plex Mono');
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await page.evaluate(() => { const e = window.whiteboard.board.read('rect')!; return e.type === 'rect' ? e.props.text : undefined; })).toBe('Freshly committed label');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await page.evaluate(() => { const e = window.whiteboard.board.read('rect')!; return e.type === 'rect' ? e.props.text : undefined; })).toBe('Rectangle text');
});

test('runtime read-only guard prevents control writes even before chrome refreshes', async ({ page }) => {
  await select(page, ['rect']); const before = await records(page);
  await page.evaluate(() => { window.whiteboard.readOnly = true; });
  await page.getByLabel(horizontal, { exact: true }).selectOption('right'); await page.getByLabel(vertical, { exact: true }).selectOption('bottom'); await page.getByLabel('Font', { exact: true }).selectOption('IBM Plex Mono');
  expect(await records(page)).toEqual(before); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
});
