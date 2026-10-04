import { test, expect } from '@playwright/test';
import type { ThreeRenderer } from '@whiteboard/renderer';

test('idle native WebGL stops drawing and document, overlays, glyphs and images wake it', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, renderer } = window.whiteboard;
    let draws = 0; const render = renderer.webgl.render.bind(renderer.webgl);
    renderer.webgl.render = (...args) => { draws++; render(...args); };
    const frames = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
    await renderer.whenReady(); await frames(); const beforeIdle = draws; await frames(30);
    const idleDelta = draws - beforeIdle;
    const triggers: { name: string; draws: number }[] = [];
    const check = async (name: string, action: () => void) => { const before = draws; action(); await frames(); triggers.push({ name, draws: draws - before }); };
    let id = '';
    await check('document', () => { id = board.create('sticky', { x: 0, y: 0, w: 180, h: 140, props: { text: 'Ready 日本語', autoSize: false, align: 'left' } }).id; });
    await renderer.whenReady(); await frames();
    await check('transform', () => board.update(id, { x: 30 }));
    await check('camera', () => renderer.setCamera({ x: 10, y: 10, zoom: 1.2 }));
    await check('resize', () => { const canvas = document.querySelector<HTMLCanvasElement>('.board-canvas')!; renderer.resize(canvas.clientWidth, canvas.clientHeight); });
    await check('selection', () => renderer.setSelection({ marquee: { x: 0, y: 0, w: 70, h: 60 } }));
    const live = board.create('stroke', { props: { points: [0, 0, .5, 30, 30, .5], simplified: true } });
    await frames(); await check('live stroke', () => renderer.setLiveStroke(live));
    await check('clear stroke', () => renderer.setLiveStroke(null));
    await check('editing', () => renderer.setEditingText(id));
    await check('restore text', () => renderer.setEditingText(null));
    const peer = { clientId: 'native-peer', name: 'Async 日本語', color: '#4378ed', cursor: { x: 60, y: 60 }, selection: [id], editingTextId: id };
    await check('presence', () => renderer.setPresence([peer]));
    while (renderer.stats().pendingPresenceLabels) await frames();
    await check('presence move', () => renderer.setPresence([{ ...peer, cursor: { x: 90, y: 90 } }]));
    await check('presence clear', () => renderer.setPresence([]));
    await check('delete', () => board.delete([id]));
    await frames(); const finalBefore = draws; await frames(20); const finalIdleDelta = draws - finalBefore;

    // A delayed source on a second real WebGL projection isolates binding from document edits.
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    const source = document.createElement('canvas'); source.width = source.height = 10;
    const context = source.getContext('2d')!; context.fillStyle = '#00ff00'; context.fillRect(0, 0, 10, 10);
    let resolveAsset!: (url: string) => void;
    const Projection = renderer.constructor as typeof ThreeRenderer;
    const probe = new Projection({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', resolveAsset: () => new Promise<string>(resolve => { resolveAsset = resolve; }) });
    let imageDraws = 0; const probeRender = probe.webgl.render.bind(probe.webgl);
    probe.webgl.render = (...args) => { imageDraws++; probeRender(...args); };
    try {
      const image = board.create('image', { x: 0, y: 0, w: 10, h: 10, props: { assetId: 'delayed', naturalW: 10, naturalH: 10 } });
      board.delete([image.id]); probe.setElements([image]); probe.render(false);
      const imageBefore = imageDraws; for (let i = 0; i < 10; i++) probe.render(false);
      const imageIdleDelta = imageDraws - imageBefore;
      resolveAsset(source.toDataURL()); await probe.whenReady(); probe.render(false);
      const imageReadyDelta = imageDraws - imageBefore;
      probe.render(false); const imageFinalIdleDelta = imageDraws - imageBefore - imageReadyDelta;
      const png = await probe.exportPng({ bounds: { x: 0, y: 0, w: 10, h: 10 }, scale: 1 });
      const bitmap = await createImageBitmap(png); context.drawImage(bitmap, 0, 0); bitmap.close();
      const green = Array.from(context.getImageData(5, 5, 1, 1).data);
      return { idleDelta, finalIdleDelta, triggers, imageIdleDelta, imageReadyDelta, imageFinalIdleDelta, green };
    } finally { probe.dispose(); renderer.webgl.render = render; }
  });
  expect(result.idleDelta).toBe(0); expect(result.finalIdleDelta).toBe(0);
  for (const trigger of result.triggers) expect(trigger.draws, trigger.name).toBeGreaterThan(0);
  expect(result.imageIdleDelta).toBe(0); expect(result.imageReadyDelta).toBe(1); expect(result.imageFinalIdleDelta).toBe(0);
  expect(result.green).toEqual([0, 255, 0, 255]); expect(errors).toEqual([]);
});
