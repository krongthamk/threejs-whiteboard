import { test, expect, type Page } from '@playwright/test';

async function readable(page: Page, selector: string) {
  const values = await page.locator(selector).evaluateAll(elements => {
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const blend = (color: number[], behind: number[]) => behind.map((value, i) => color[i]! * (color[3] ?? 1) + value * (1 - (color[3] ?? 1)));
    const luminance = (color: number[]) => color.slice(0, 3).reduce((sum, channel, i) => {
      const value = channel / 255;
      return sum + [0.2126, 0.7152, 0.0722][i]! * (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    }, 0);
    return elements.map(element => {
      const ancestors: Element[] = []; let parent: Element | null = element;
      while (parent) { ancestors.unshift(parent); parent = parent.parentElement; }
      const background = ancestors.reduce((color, node) => blend(rgb(getComputedStyle(node).backgroundColor), color), [255, 255, 255]);
      const style = getComputedStyle(element), ink = luminance(blend(rgb(style.color), background)), paper = luminance(background);
      return { text: element.textContent?.trim().slice(0, 40), size: parseFloat(style.fontSize), contrast: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05) };
    });
  });
  expect(values.length, selector).toBeGreaterThan(0);
  for (const value of values) {
    expect.soft(value.size, `${selector}: ${value.text}`).toBeGreaterThanOrEqual(11);
    expect.soft(value.contrast, `${selector}: ${value.text}`).toBeGreaterThanOrEqual(4.5);
  }
}

for (const width of [1440, 390]) test(`muted UI text stays readable at ${width}px including responsive rules`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await readable(page, '.workspace-label,.tool-hint,.empty-board p,.empty-board span');
  await page.getByRole('button', { name: 'Open minimap', exact: true }).click();
  await readable(page, '.minimap-heading');
  await page.evaluate(() => {
    const shape = window.whiteboard.board.create('rect'); window.whiteboard.session.setState({ selectedIds: [shape.id] });
  });
  await readable(page, '.number-field span');
  await page.getByRole('button', { name: 'Export board', exact: true }).click();
  await readable(page, '.export-formats small,.dialog-description');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await readable(page, '.shortcut-list kbd');
});

test('sign-in supporting text has readable contrast and size', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await readable(page, '.eyebrow,.signin-card>p:not(.eyebrow)');
});

test('keyboard canvas focus is visible and disabled controls remain distinguishable', async ({ page }) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.keyboard.press('Tab');
  const canvas = page.locator('.board-canvas'); await expect(canvas).toBeFocused();
  const focus = await canvas.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) }; });
  expect(focus.style).toBe('solid'); expect(focus.width).toBeGreaterThanOrEqual(2); expect(focus.offset).toBeLessThanOrEqual(0);
  const undo = page.getByRole('button', { name: 'Undo', exact: true }); await expect(undo).toBeDisabled();
  const disabled = await undo.evaluate(element => { const style = getComputedStyle(element); return { opacity: parseFloat(style.opacity), color: style.color, background: style.backgroundColor }; });
  expect(disabled.opacity).toBeGreaterThanOrEqual(.45); expect(disabled.opacity).toBeLessThanOrEqual(.6);
  expect(disabled.background).not.toBe('rgba(0, 0, 0, 0)');
});
