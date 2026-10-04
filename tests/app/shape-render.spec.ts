import { test, expect } from '@playwright/test';
import { createElement, textBlock, textLayout } from '@whiteboard/model';
import type { ThreeRenderer } from '@whiteboard/renderer';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory } from '../evidence';

const fixtures = [
  ...(['rect', 'ellipse'] as const).flatMap(type => (['top', 'middle', 'bottom'] as const).map(verticalAlign => createElement(type, { id: `${type}-${verticalAlign}`, x: 60, y: 40, w: 200, h: 160, style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 48 }, props: { text: 'HI', align: 'center', autoSize: false, verticalAlign } }))),
  createElement('ellipse', { id: 'rotated', x: 60, y: 40, w: 200, h: 160, rotation: .35, style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 40 }, props: { text: 'HI', align: 'center', autoSize: false, verticalAlign: 'middle' } }),
  createElement('rect', { id: 'wrapped', x: 85, y: 40, w: 150, h: 160, style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 24 }, props: { text: 'wrap wrap wrap wrap', align: 'left', autoSize: false, verticalAlign: 'middle' } }),
  createElement('rect', { id: 'overflow', x: 85, y: 88, w: 150, h: 64, style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 48 }, props: { text: 'MMM\nMMM\nMMM', align: 'center', autoSize: false, verticalAlign: 'middle' } }),
  ...(['rect', 'ellipse'] as const).map(type => createElement(type, { id: `tiny-${type}`, x: 148, y: 108, w: 24, h: 24, style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 48 }, props: { text: 'Stored\ntext', align: 'center', autoSize: false, verticalAlign: 'bottom' } })),
].map(element => ({ element, block: textBlock(element)!, layout: textLayout(element) }));

function save(directory: string, name: string, data: string): void { writeFileSync(`${directory}/${name}.png`, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')); }

test('shape labels use aligned inset boxes and clip overflow on the live canvas and PNG at both scales', async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const results = await page.evaluate(async fixtures => {
    const Renderer = window.whiteboard.renderer.constructor as typeof ThreeRenderer, canvas = document.createElement('canvas');
    const renderer = new Renderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff', fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', background: '#ffffff', pixelRatio: 1 });
    renderer.resize(320, 240); renderer.setCamera({ x: 160, y: 120, zoom: 1 });
    const results = [];
    try {
      for (const { element, block, layout } of fixtures) {
        renderer.setElements([element]); await renderer.whenReady(); renderer.render();
        const inspect = (source: CanvasImageSource, scale: number) => {
          const raster = document.createElement('canvas'); raster.width = 320 * scale; raster.height = 240 * scale;
          const paint = raster.getContext('2d')!; paint.drawImage(source, 0, 0); const pixels = paint.getImageData(0, 0, raster.width, raster.height).data;
          let ink = 0, outside = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const cos = Math.cos(element.rotation), sin = Math.sin(element.rotation), cx = element.x + element.w / 2, cy = element.y + element.h / 2;
          for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
            const at = (y * raster.width + x) * 4;
            if (pixels[at]! > 64 || pixels[at + 1]! > 64 || pixels[at + 2]! > 64 || pixels[at + 3]! < 128) continue;
            const px = (x + .5) / scale, py = (y + .5) / scale, dx = px - cx, dy = py - cy;
            const localX = cx + cos * dx + sin * dy - element.x, localY = cy - sin * dx + cos * dy - element.y;
            if (localX < block.insetX - 1 || localX > element.w - block.insetX + 1 || localY < block.insetY - 1 || localY > element.h - block.insetY + 1) outside++;
            ink++; minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
          }
          const margin = [...paint.getImageData((element.x + block.insetX / 2) * scale, (element.y + element.h / 2) * scale, 1, 1).data];
          return { ink, outside, bounds: ink ? [minX, minY, maxX, maxY] : null, margin, raster: raster.toDataURL() };
        };
        const screen = inspect(canvas, 1), png = [];
        for (const scale of [1, 2]) {
          const blob = await renderer.exportPng({ bounds: { x: 0, y: 0, w: 320, h: 240 }, scale, transparent: false });
          const bitmap = await createImageBitmap(blob); try { png.push(inspect(bitmap, scale)); } finally { bitmap.close(); }
        }
        const object = renderer.getTextObject(element.id);
        results.push({ id: element.id, screen, png, position: object ? [object.position.x, -object.position.y] : null, clipRect: object?.clipRect, pending: renderer.stats().pendingTexts, stored: element.props, lines: layout.lines.length });
      }
      return results;
    } finally { renderer.dispose(); }
  }, fixtures);
  const directory = evidenceDirectory(testInfo); writeFileSync(`${directory}/shape-labels.json`, JSON.stringify(results, null, 2));
  for (const [index, result] of results.entries()) {
    const { element, block, layout } = fixtures[index]!;
    for (const [name, image] of [['screen', result.screen], ['png1', result.png[0]!], ['png2', result.png[1]!]] as const) {
      save(directory, `${result.id}-${name}`, image.raster);
      expect(image.outside, `${result.id} ${name} clipped ink`).toBe(0);
      if (result.id.startsWith('tiny')) expect(image.ink, `${result.id} ${name}`).toBe(0);
      else expect(image.ink, `${result.id} ${name}`).toBeGreaterThan(30);
    }
    if (!result.id.startsWith('tiny')) {
      for (const image of result.png) for (let i = 0; i < 4; i++) expect(Math.abs(image.bounds![i]! - result.screen.bounds![i]!)).toBeLessThanOrEqual(1);
      expect(result.clipRect).toHaveLength(4);
      if (element.rotation === 0) {
        expect(result.position![1]).toBeCloseTo(element.y + block.insetY + (layout.verticalOffset ?? 0) + element.style.fontSize);
        expect(result.screen.margin).toEqual([102, 204, 255, 255]);
      }
    }
    expect(result.pending).toBe(0);
  }
  for (const type of ['rect', 'ellipse']) {
    const top = results.find(item => item.id === `${type}-top`)!, middle = results.find(item => item.id === `${type}-middle`)!, bottom = results.find(item => item.id === `${type}-bottom`)!;
    expect(top.screen.bounds![1]).toBeLessThan(middle.screen.bounds![1]!); expect(middle.screen.bounds![1]).toBeLessThan(bottom.screen.bounds![1]!);
    expect(Math.abs((middle.screen.bounds![0]! + middle.screen.bounds![2]!) / 2 - 160)).toBeLessThanOrEqual(3);
    expect(Math.abs((middle.screen.bounds![1]! + middle.screen.bounds![3]!) / 2 - 120)).toBeLessThan(8);
  }
  expect(results.find(item => item.id === 'wrapped')!.lines).toBeGreaterThan(1);
});

test('shape label depth follows equal-index IDs through opaque and translucent occlusion and selected-only export', async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const { board, renderer, session, exporter } = window.whiteboard;
    board.create('rect', { id: 'a-label', x: 0, y: 0, w: 200, h: 160, index: 'a0', style: { fill: '#66ccff', color: '#000000', strokeWidth: 0, fontSize: 48 }, props: { text: 'HI', align: 'center', autoSize: false, verticalAlign: 'middle' } });
    session.setState({ camera: { x: 100, y: 80, zoom: 1 } }); await renderer.whenReady(); renderer.render();
    let probe = -1;
    const sample = async () => {
      const blob = await exporter.create({ format: 'png', scale: 1, transparent: false, padding: 0, title: 'Order' });
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const paint = canvas.getContext('2d')!; paint.drawImage(bitmap, 0, 0); bitmap.close();
      let screen: number[] | null = null;
      if (probe >= 0) {
        await renderer.whenReady(); renderer.render();
        const live = renderer.webgl.domElement, snapshot = document.createElement('canvas'); snapshot.width = live.width; snapshot.height = live.height;
        const context = snapshot.getContext('2d')!; context.drawImage(live, 0, 0);
        const ratio = renderer.webgl.getPixelRatio(), x = probe / 4 % canvas.width + .5, y = Math.floor(probe / 4 / canvas.width) + .5;
        screen = [...context.getImageData(live.width / 2 + (x - 100) * ratio, live.height / 2 + (y - 80) * ratio, 1, 1).data];
      }
      return { pixels: [...paint.getImageData(0, 0, canvas.width, canvas.height).data], data: canvas.toDataURL(), width: canvas.width, screen };
    };
    const baseline = await sample(), at = baseline.pixels.findIndex((_, at) => at % 4 === 0 && baseline.pixels[at] === 0 && baseline.pixels[at + 1] === 0 && baseline.pixels[at + 2] === 0);
    probe = at;
    if (at < 0) throw new Error('Shape label produced no black glyph pixels.');
    board.create('rect', { id: 'z-cover', x: 0, y: 0, w: 200, h: 160, index: 'a0', style: { fill: '#ff0000', strokeWidth: 0 } });
    const opaque = await sample(); board.update('z-cover', { style: { ...board.read('z-cover')!.style, opacity: .5 } }); const translucent = await sample();
    const selected = await exporter.create({ format: 'png', selection: ['a-label'], scale: 1, transparent: true, padding: 0, title: 'Selected label' });
    const bitmap = await createImageBitmap(selected), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const paint = canvas.getContext('2d')!; paint.drawImage(bitmap, 0, 0); bitmap.close(); const selectedPixels = [...paint.getImageData(0, 0, canvas.width, canvas.height).data];
    board.update('a-label', { index: 'a1' }); const reordered = await sample();
    return { at, baseline: baseline.data, opaque: opaque.data, translucent: translucent.data, selected: canvas.toDataURL(), reordered: reordered.data,
      screenColors: [opaque.screen, translucent.screen, reordered.screen],
      colors: [opaque, translucent, { pixels: selectedPixels }, reordered].map(image => image.pixels.slice(at, at + 4)) };
  });
  const directory = evidenceDirectory(testInfo); for (const name of ['baseline', 'opaque', 'translucent', 'selected', 'reordered'] as const) save(directory, name, result[name]);
  writeFileSync(`${directory}/order.json`, JSON.stringify({ png: result.colors, screen: result.screenColors }));
  expect(result.at).toBeGreaterThanOrEqual(0);
  for (const [index, expected] of [[255, 0, 0, 255], [128, 0, 0, 255], [0, 0, 0, 255]].entries()) for (let channel = 0; channel < 4; channel++) expect(Math.abs(result.screenColors[index]![channel]! - expected[channel]!)).toBeLessThanOrEqual(2);
  for (const [index, expected] of [[255, 0, 0, 255], [128, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]].entries()) for (let channel = 0; channel < 4; channel++) expect(Math.abs(result.colors[index]![channel]! - expected[channel]!)).toBeLessThanOrEqual(2);
});
