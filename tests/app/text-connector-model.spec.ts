import { expect, test } from '@playwright/test';

test('unsupported text stays editable and saved with a visible nonblocking coverage notice', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.create('text', { id: 'coverage-text' }); app.board.undoManager.clear(); app.textEditor.open('coverage-text');
  });
  const input = page.getByRole('textbox', { name: 'Edit text' }); await expect(input).toBeFocused();
  await page.keyboard.insertText('กก'); await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert')).toContainText('U+0E01');
  await expect(page.getByRole('alert')).toContainText('Text layout may be approximate');
  expect(await page.evaluate(() => ({ text: window.whiteboard.board.read('coverage-text')!.props, history: window.whiteboard.board.undoManager.undoStack.length })))
    .toMatchObject({ text: { text: 'กก' }, history: 1 });
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.evaluate(() => window.whiteboard.board.updateStyle(['coverage-text'], { color: '#123456' }));
  await expect(page.getByRole('alert')).toHaveCount(0);
  const message = await page.evaluate(async () => {
    try { await window.whiteboard.exporter.create({ format: 'pdf', scale: 1, transparent: false, title: 'Missing font' }); return ''; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  expect(message).toContain('PDF export has no shipped font for U+0E01');
  expect(errors).toEqual([]);
});

test('standalone connector drag keeps its binding in preview and commit while a copy is shifted and independent', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const app = window.whiteboard;
    app.board.create('rect', { id: 'bound-target', x: -250, y: -100, w: 100, h: 100 });
    app.board.create('connector', { id: 'bound-connector', props: { start: { elementId: 'bound-target', nx: 1, ny: .5, fallback: { x: -150, y: -50 } }, end: { x: 150, y: 100 }, kind: 'straight' } });
    app.session.setState({ selectedIds: ['bound-connector'] }); app.board.undoManager.clear();
    const apply = app.renderer.applyDiff.bind(app.renderer);
    app.renderer.applyDiff = (upserts, removals) => {
      const connector = upserts.find(element => element.id === 'bound-connector');
      if (connector) Reflect.set(window, 'connectorPreview', connector.props);
      apply(upserts, removals);
    };
  });
  const canvas = page.locator('canvas').first(), bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2 + 25;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 30, { steps: 3 });
  const preview = await page.evaluate(() => Reflect.get(window, 'connectorPreview'));
  expect(preview).toMatchObject({ start: { elementId: 'bound-target' }, end: { x: 190, y: 130 } });
  expect(await page.evaluate(() => window.whiteboard.board.read('bound-connector')!.props)).toMatchObject({ end: { x: 150, y: 100 } });
  await page.mouse.up();
  expect(await page.evaluate(() => window.whiteboard.board.read('bound-connector')!.props)).toEqual(preview);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  const result = await page.evaluate(() => {
    const board = window.whiteboard.board, [id] = board.duplicate(['bound-connector']);
    const copy = board.read(id!)!; board.move(['bound-target'], { x: 100, y: 200 });
    return { copy: copy.props, later: board.read(id!)!.props, original: board.read('bound-connector')!.props };
  });
  expect(result.copy).toMatchObject({ start: { x: -126, y: -26 }, end: { x: 214, y: 154 } });
  expect(result.copy).not.toHaveProperty('start.elementId'); expect(result.later).toEqual(result.copy);
  expect(result.original).toMatchObject({ start: { elementId: 'bound-target' } });
  expect(errors).toEqual([]);
});
