import { test, expect } from '@playwright/test';
import type { BoardDocument } from '@whiteboard/model';
import type { ThreeRenderer } from '@whiteboard/renderer';
import { writeFileSync } from 'node:fs';
import { evidenceDirectory } from '../evidence';

test('regional reentry recreates evicted text and images, retains edge textures and closes every bitmap', async ({ page }, testInfo) => {
  await page.goto('/?local=1'); await page.waitForFunction(() => !!window.whiteboard);
  const result = await page.evaluate(async () => {
    const Renderer = window.whiteboard.renderer.constructor as typeof ThreeRenderer, Document = window.whiteboard.board.constructor as typeof BoardDocument;
    const source = document.createElement('canvas'); source.width = source.height = 40;
    const paint = source.getContext('2d')!; paint.fillStyle = '#00ff00'; paint.fillRect(0, 0, 40, 40);
    const url = source.toDataURL(), board = new Document();
    for (let n = 0; n < 8; n++) {
      board.create('text', { id: `text-${n}`, x: n * 2000 - 50, y: -25, w: 80, h: 20, style: { fontSize: 16, color: '#000000' }, props: { text: `Region ${n}`, align: 'left', autoSize: false } });
      board.create('image', { id: `image-${n}`, x: n * 2000 + 20, y: 0, w: 40, h: 40, style: { strokeWidth: 0 }, props: { assetId: String(n), naturalW: 40, naturalH: 40 } });
    }
    let bitmaps = 0, closes = 0;
    const originalDecode = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => originalDecode(...args).then(bitmap => {
      bitmaps++; const close = bitmap.close.bind(bitmap); bitmap.close = () => { closes++; close(); }; return bitmap;
    })) as typeof createImageBitmap;
    const canvas = document.createElement('canvas');
    const projection = new Renderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', resolveAsset: () => url, offscreenTextCacheSize: 2, offscreenImageCacheSize: 2, background: '#ffffff', pixelRatio: 1 });
    projection.resize(200, 100); projection.setElements(board.readAll());
    const samples: { texts: number; images: number }[] = [];
    let edgeDecodeDelta = 0, reentryGreen: number[] = [], textInk = 0, originalTextRetained = false, thumbnailDecodeDelta = 0;
    try {
      const visit = async (n: number) => { projection.setCamera({ x: n * 2000, y: 0, zoom: 1 }); projection.render(); await projection.whenReady(); projection.render(); samples.push({ texts: projection.stats().textInstances, images: projection.stats().imageInstances }); };
      for (let n = 0; n < 8; n++) await visit(n);
      await visit(0); const originalText = projection.getTextObject('text-0')!;
      const beforeEdge = bitmaps;
      // Camera x161 means viewport left61, just one pixel beyond image right60.
      projection.setCamera({ x: 161, y: 0, zoom: 1 }); projection.render(); await projection.whenReady();
      projection.setCamera({ x: 0, y: 0, zoom: 1 }); projection.render(); await projection.whenReady(); edgeDecodeDelta = bitmaps - beforeEdge;
      const beforeExport = bitmaps;
      const png = await projection.exportPng({ bounds: { x: 3900, y: -50, w: 200, h: 100 }, scale: 1 });
      // One full tile-source bitmap is expected; the interactive thumbnail stays bound.
      await projection.whenReady(); thumbnailDecodeDelta = bitmaps - beforeExport;
      originalTextRetained = projection.getTextObject('text-0') === originalText;
      const bitmap = await createImageBitmap(png), output = document.createElement('canvas'); output.width = bitmap.width; output.height = bitmap.height;
      const context = output.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      reentryGreen = [...context.getImageData(140, 70, 1, 1).data];
      const pixels = context.getImageData(45, 20, 90, 30).data;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 200 && pixels[i + 1]! < 200 && pixels[i + 2]! < 200) textInk++;
      await visit(0);
    } finally { projection.dispose(); board.destroy(); window.createImageBitmap = originalDecode; }
    return { samples, edgeDecodeDelta, thumbnailDecodeDelta, originalTextRetained, reentryGreen, textInk, bitmaps, closes };
  });
  for (const sample of result.samples) { expect(sample.texts).toBeLessThanOrEqual(3); expect(sample.images).toBeLessThanOrEqual(3); }
  expect(result.edgeDecodeDelta).toBe(0); expect(result.thumbnailDecodeDelta).toBe(1); expect(result.originalTextRetained).toBe(true);
  expect(result.reentryGreen).toEqual([0, 255, 0, 255]); expect(result.textInk).toBeGreaterThan(0); expect(result.closes).toBe(result.bitmaps);
  writeFileSync(`${evidenceDirectory(testInfo)}/cache.json`, JSON.stringify(result, null, 2));
});
