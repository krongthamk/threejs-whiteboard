import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const { board, session } = window.whiteboard;
    board.create('rect', { id: 'keyboard-shape', x: -200, y: -200 });
    session.setState({ selectedIds: ['keyboard-shape'] });
  });
});

const ids = (page: Page) => page.evaluate(() => window.whiteboard.board.readAll().map(element => element.id));

test('Space activates a focused export button without starting canvas panning', async ({ page }) => {
  await page.getByRole('button', { name: 'Export board', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.locator('.board-canvas').evaluate(canvas => (canvas as HTMLElement).style.cursor)).not.toBe('grab');
});

test('Backspace on a focused swatch preserves the board selection', async ({ page }) => {
  await page.getByRole('button', { name: 'Fill #dbe9ff', exact: true }).focus();
  await page.keyboard.press('Backspace');
  expect(await ids(page)).toEqual(['keyboard-shape']);
  expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds)).toEqual(['keyboard-shape']);
});

test('links, summaries and role buttons retain their keyboard events', async ({ page }) => {
  await page.evaluate(() => {
    const controls = document.createElement('div'); controls.id = 'keyboard-controls';
    controls.innerHTML = '<a href="#target">Test link</a><details><summary>Test summary</summary>Details</details><div role="button" tabindex="0"><span>Test role button</span></div>';
    document.body.append(controls);
  });
  for (const selector of ['a', 'summary', '[role="button"]']) {
    await page.locator(`#keyboard-controls ${selector}`).focus(); await page.keyboard.press('Backspace');
    expect(await ids(page)).toEqual(['keyboard-shape']);
  }
  await page.locator('#keyboard-controls summary').focus(); await page.keyboard.press('Space');
  await expect(page.locator('#keyboard-controls details')).toHaveAttribute('open', '');
});

test('physical letter shortcuts work with a Thai key value for tools and history', async ({ page }) => {
  await page.locator('.board-canvas').focus();
  const cdp = await page.context().newCDPSession(page);
  const modifier = await page.evaluate(() => navigator.platform.includes('Mac') ? 4 : 2);
  const key = async (code: string, value: string, modifiers = 0) => {
    const event = { code, key: value, modifiers, windowsVirtualKeyCode: code.charCodeAt(3), nativeVirtualKeyCode: code.charCodeAt(3) };
    await cdp.send('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
    await cdp.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  };
  try {
    await key('KeyR', 'พ'); expect(await page.evaluate(() => window.whiteboard.session.getState().tool)).toBe('rect');
    await key('KeyV', 'อ'); expect(await page.evaluate(() => window.whiteboard.session.getState().tool)).toBe('select');
    await page.evaluate(() => window.whiteboard.session.setState({ selectedIds: [] }));
    await key('KeyA', 'ฟ', modifier); expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds)).toEqual(['keyboard-shape']);
    await key('KeyD', 'ก', modifier); expect(await ids(page)).toHaveLength(2);
    await key('KeyZ', 'ผ', modifier); expect(await ids(page)).toEqual(['keyboard-shape']);
    await key('KeyZ', 'ผ', modifier | 8); expect(await ids(page)).toHaveLength(2);
    await key('KeyZ', 'ผ', modifier); expect(await ids(page)).toHaveLength(1);
    await key('KeyY', 'ั', modifier); expect(await ids(page)).toHaveLength(2);
  } finally { await cdp.detach(); }
});

test('read-only letter shortcuts preserve the current tool and document', async ({ page }) => {
  await page.evaluate(() => { window.whiteboard.readOnly = true; });
  await page.locator('.board-canvas').focus();
  for (const key of ['r', 'o', 'n', 'p', 'e', 't', 'c', 'h']) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => window.whiteboard.session.getState().tool)).toBe('select');
  }
  expect(await ids(page)).toEqual(['keyboard-shape']);
});
