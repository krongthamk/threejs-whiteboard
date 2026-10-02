import { test, expect } from '@playwright/test';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime } }

test('a board render failure shows recovery controls and reload opens the board again', async ({ page }) => {
  await page.goto('/?local=1');
  await page.waitForFunction(() => !!window.whiteboard);
  await page.getByRole('button', { name: 'Open minimap', exact: true }).click();
  await page.evaluate(() => {
    const { board } = window.whiteboard;
    board.readAll = () => { throw new Error('Deliberate minimap projection failure'); };
    // This revision reaches Minimap's real React render, outside the runtime subscriber.
    board.create('rect', { id: 'healthy-trigger', x: -100, y: -100 });
  });
  await expect(page.getByRole('alert')).toContainText('This board could not be displayed');
  await page.getByRole('button', { name: 'Reload board', exact: true }).click();
  await page.waitForFunction(() => !!window.whiteboard);
  await expect(page.getByRole('button', { name: 'Rectangle', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('poisoned records produce a notice while healthy items can still be edited and exported', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1');
  await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const { board, session } = window.whiteboard;
    const healthy = board.create('rect', { id: 'healthy', x: -100, y: -100 });
    board.doc.transact(() => {
      board.doc.getArray('element-properties:poison-test').push([
        { key: JSON.stringify(['poisoned', '$base']), val: { stamp: { clock: 1, actor: 'poison-test' }, value: { generation: 'poison-generation', element: { ...healthy, id: 'poisoned', x: 'nope' } } } },
        { key: 'not-json', val: { stamp: { clock: 2, actor: 'poison-test' }, value: null } },
        null,
      ]);
    }, 'remote-poison-fixture');
    session.setState({ selectedIds: ['healthy'] });
  });
  const notice = page.getByRole('status', { name: 'Board data notice' });
  await expect(notice).toContainText('1 invalid element');
  await expect(notice).toContainText('2 malformed records');
  await expect.poll(() => page.evaluate(() => window.whiteboard.elementCount)).toBe(1);
  await page.getByRole('button', { name: 'Open minimap', exact: true }).click();
  await page.getByRole('button', { name: 'Minimap · drag to navigate, Enter to fit board', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close minimap', exact: true }).click();
  await page.locator('.board-canvas').focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.whiteboard.board.read('healthy')!.x)).toBe(-99);
  const exported = await page.evaluate(async () => {
    const svg = await window.whiteboard.exporter.create({ format: 'svg', scale: 1, transparent: true, title: 'Healthy quarantine export' });
    return svg.text();
  });
  expect(exported).toContain('data-element-id="healthy"');
  expect(exported).not.toContain('data-element-id="poisoned"');
  expect(errors).toEqual([]);
});
