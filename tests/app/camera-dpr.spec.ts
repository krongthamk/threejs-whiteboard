import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory } from '../evidence';

test('camera gestures and reload stay bounded while a DPR-only change refreshes the canvas', async ({ page, context }, testInfo) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('camera-fixture-seeded')) { localStorage.setItem('whiteboard:view:local', JSON.stringify({ x: 999999, y: -999999, zoom: 1 })); sessionStorage.setItem('camera-fixture-seeded', '1'); } });
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  await page.evaluate(() => {
    const canvas = document.querySelector('.board-canvas')!;
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 1e7, deltaY: -1e7 }));
  });
  await expect.poll(() => page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual({ x: 1e6, y: -1e6, zoom: 1 });
  await page.evaluate(() => window.whiteboard.session.setState({ tool: 'pan' }));
  const canvas = page.locator('.board-canvas'); const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 - 100, bounds.y + bounds.height / 2 + 100); await page.mouse.up();
  expect(await page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual({ x: 1e6, y: -1e6, zoom: 1 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('whiteboard:view:local')!))).toEqual({ x: 1e6, y: -1e6, zoom: 1 });
  await page.reload(); await page.waitForFunction(() => !!window.whiteboard);
  expect(await page.evaluate(() => window.whiteboard.session.getState().camera)).toEqual({ x: 1e6, y: -1e6, zoom: 1 });
  await page.evaluate(() => window.whiteboard.session.setState({ camera: { x: 1e6, y: -1e6, zoom: 64 } }));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('whiteboard:view:local')!))).toEqual({ x: 1e6, y: -1e6, zoom: 64 });
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => {
    const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`), events: string[] = [];
    query.addEventListener('change', () => events.push('media'));
    window.addEventListener('resize', () => events.push('resize'));
    Object.assign(window, { dprProbe: { query, events } });
  });
  const evidence: unknown[] = [];
  try {
    for (const deviceScaleFactor of [1.5, 3, 1]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor, mobile: false });
      await expect.poll(() => page.evaluate(() => {
        const probe = (window as unknown as { dprProbe: { query: MediaQueryList; events: string[] } }).dprProbe;
        return { dpr: devicePixelRatio, ratio: window.whiteboard.renderer.webgl.getPixelRatio(), match: probe.query.matches, events: probe.events };
      })).toMatchObject({ dpr: deviceScaleFactor, ratio: Math.min(deviceScaleFactor, 2) });
      evidence.push(await page.evaluate(() => { const probe = (window as unknown as { dprProbe: { query: MediaQueryList; events: string[] } }).dprProbe; return { dpr: devicePixelRatio, ratio: window.whiteboard.renderer.webgl.getPixelRatio(), matches: probe.query.matches, events: probe.events }; }));
      const size = await page.evaluate(() => { const canvas = document.querySelector<HTMLCanvasElement>('.board-canvas')!; return { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight }; });
      expect(size.width).toBe(Math.floor(size.cssWidth * Math.min(deviceScaleFactor, 2)));
      expect(size.height).toBe(Math.floor(size.cssHeight * Math.min(deviceScaleFactor, 2)));
    }
    writeFileSync(`${evidenceDirectory(testInfo)}/dpr.json`, JSON.stringify(evidence, null, 2));
  } finally { await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach(); }
});
