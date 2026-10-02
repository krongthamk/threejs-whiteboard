import { test, expect, type Page } from '@playwright/test';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentBounds, getElementBounds } from '@whiteboard/model';

test.afterEach(({}, testInfo) => recordBrowserEvidence(testInfo, 'docs/benchmarks/phase4/images'));
async function privateBoard(page: Page, title: string) {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const back = page.getByRole('button', { name: 'Back to boards', exact: true }), create = page.getByRole('button', { name: 'New board', exact: true });
  await expect(back.or(create)).toBeVisible(); if (await back.isVisible()) await back.click();
  await create.click(); await page.getByLabel('Board name', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard?.assets && !!window.whiteboardConnection?.provider.synced);
}
function saveData(directory: string, name: string, data: string) { writeFileSync(resolve(directory, name), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')); }

test('private mixed board image pixels agree across PNG, embedded SVG and screen; controls catch missing/mirrored images', async ({ page }, testInfo) => {
  test.setTimeout(60_000); const directory = evidenceDirectory(testInfo); await privateBoard(page, 'Image parity proof');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await page.evaluate(async () => {
    const paint = document.createElement('canvas'); paint.width = 768; paint.height = 512; const context = paint.getContext('2d')!;
    context.fillStyle = '#e02820'; context.fillRect(0, 0, 384, 256);
    context.fillStyle = 'rgba(32,180,64,.5)'; context.fillRect(384, 0, 384, 256);
    context.fillStyle = '#2054df'; context.fillRect(0, 256, 384, 256);
    context.fillStyle = '#000000'; context.fillRect(30, 25, 70, 25); context.fillRect(30, 25, 25, 90);
    const blob = await new Promise<Blob>(resolve => paint.toBlob(value => resolve(value!), 'image/png'));
    await window.whiteboard.assets.importFiles([new File([blob], 'asymmetric-alpha.png', { type: 'image/png' })]);
    const { board, session } = window.whiteboard, imported = board.readAll()[0]!;
    if (imported.type !== 'image') throw new Error('Image import failed');
    board.update(imported.id, { x: 100, y: 80, w: 384, h: 256, rotation: .22, index: 'a1', style: { ...imported.style, opacity: .6 } });
    board.create('rect', { id: 'backdrop', x: 50, y: 25, w: 490, h: 375, index: 'a0', style: { fill: '#eeddbb', strokeWidth: 0 } });
    board.create('text', { id: 'caption', x: 50, y: 440, index: 'a2', style: { fontSize: 28 }, props: { text: 'Original image · shared idea', align: 'left', autoSize: true } });
    board.create('ellipse', { id: 'destination', x: 610, y: 135, w: 120, h: 100, index: 'a3', style: { fill: '#dbe9ff', stroke: '#334155', strokeWidth: 3 } });
    board.create('connector', { id: 'arrow', index: 'a4', style: { stroke: '#334155', strokeWidth: 3 }, props: { start: { x: 550, y: 185 }, end: { elementId: 'destination', nx: 0, ny: .5, fallback: { x: 610, y: 185 } }, kind: 'straight' } });
    session.setState({ selectedIds: [] }); window.whiteboard.controller.zoomToFit();
    return { id: imported.id, assetId: imported.props.assetId, bytes: [...new Uint8Array(await blob.arrayBuffer())], dataUrl: paint.toDataURL(), elements: board.readAll(), probes: [[.2, .2], [.75, .2], [.2, .75], [.75, .75]].map(([u, v]) => ({ u: u!, v: v!, rgba: [...context.getImageData(Math.floor(u! * 768), Math.floor(v! * 512), 1, 1).data] })) };
  });
  const boardId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect([...await (await page.request.get(`/api/boards/${boardId}/assets/${source.assetId}`)).body()]).toEqual(source.bytes);
  const raw = contentBounds(source.elements), map = new Map(source.elements.map(element => [element.id, element]));
  const regions = source.elements.filter(element => element.id !== 'backdrop').map(element => ({ name: element.id, type: element.type, ...getElementBounds(element, map) }));
  const comparison = await page.evaluate(async ({ raw, regions, heroId, probes, originalBytes }) => {
    const { board, exporter, renderer } = window.whiteboard, hero = board.read(heroId)!;
    const box = { x: raw.x - 24, y: raw.y - 24, w: raw.w + 48, h: raw.h + 48 }, scale = 2;
    const width = Math.ceil(box.w * scale), height = Math.ceil(box.h * scale);
    const paint = document.createElement('canvas'); paint.width = width; paint.height = height; const context = paint.getContext('2d')!;
    const toData = async (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
    const png = await exporter.create({ format: 'png', scale, transparent: false, title: 'Private mixed image' });
    const svg = await exporter.create({ format: 'svg', scale, transparent: false, title: 'Private mixed image' });
    const svgText = await svg.text(), doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const hrefs = [...doc.querySelectorAll('image')].map(image => image.getAttribute('href')!);
    const embeddedBytes = [...new Uint8Array(await (await fetch(hrefs[0]!)).arrayBuffer())];
    const fonts = [...(doc.querySelector('style')?.textContent ?? '').matchAll(/font-family:'([^']+)';src:url\('([^']+)'\)/g)];
    for (const [, family, data] of fonts) document.fonts.add(await new FontFace(family!, `url(${data})`).load());
    const rasterSvg = async (text: string) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })), image = new Image();
      try { image.src = url; await image.decode(); context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, box.w * scale, box.h * scale); return { pixels: context.getImageData(0, 0, width, height).data, dataUrl: paint.toDataURL() }; }
      finally { URL.revokeObjectURL(url); }
    };
    const svgRaster = await rasterSvg(svgText), bitmap = await createImageBitmap(png);
    context.clearRect(0, 0, width, height); context.drawImage(bitmap, 0, 0); bitmap.close(); const pngPixels = context.getImageData(0, 0, width, height).data;
    let opaqueAlphaMin = 255; for (let offset = 3; offset < pngPixels.length; offset += 4) opaqueAlphaMin = Math.min(opaqueAlphaMin, pngPixels[offset]!);
    renderer.resize(width, height); renderer.setCamera({ x: box.x + width / (2 * scale), y: box.y + height / (2 * scale), zoom: scale });
    renderer.webgl.setClearColor('#ffffff'); renderer.layers.grid.visible = false; renderer.layers.selectionUI.visible = false; renderer.layers.presence.visible = false;
    await renderer.whenReady(); renderer.render(); context.clearRect(0, 0, width, height); context.drawImage(renderer.webgl.domElement, 0, 0, width, height);
    const screenPixels = context.getImageData(0, 0, width, height).data, screenRaster = paint.toDataURL();
    // Same S4 raster allowance: 48 channel values and a one-output-pixel (0.5 CSS px) edge neighborhood.
    // Denominators cover only the region's non-white content, never whole-board whitespace.
    const compare = (left: Uint8ClampedArray, right: Uint8ClampedArray, region: typeof regions[number]) => {
      const x0 = Math.max(1, Math.floor((region.x - box.x) * scale) - 2), y0 = Math.max(1, Math.floor((region.y - box.y) * scale) - 2);
      const x1 = Math.min(width - 1, Math.ceil((region.x + region.w - box.x) * scale) + 2), y1 = Math.min(height - 1, Math.ceil((region.y + region.h - box.y) * scale) + 2);
      const differs = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => [0, 1, 2, 3].some(c => Math.abs(a[ai + c]! - b[bi + c]!) > 48);
      const nearby = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!differs(a, ai, b, bi + (dy * width + dx) * 4)) return true; return false; };
      let foreground = 0, mismatches = 0; let inkA: number[] | null = null, inkB: number[] | null = null;
      const ink = (previous: number[] | null, x: number, y: number) => previous ? [Math.min(previous[0]!, x), Math.min(previous[1]!, y), Math.max(previous[2]!, x), Math.max(previous[3]!, y)] : [x, y, x, y];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const offset = (y * width + x) * 4; if (![0, 1, 2].some(c => left[offset + c]! < 245 || right[offset + c]! < 245)) continue;
        foreground++; if (Math.max(left[offset]!, left[offset + 1]!, left[offset + 2]!) < 160) inkA = ink(inkA, x, y);
        if (Math.max(right[offset]!, right[offset + 1]!, right[offset + 2]!) < 160) inkB = ink(inkB, x, y);
        if (differs(left, offset, right, offset) && (!nearby(left, offset, right, offset) || !nearby(right, offset, left, offset))) mismatches++;
      }
      return { name: region.name, type: region.type, foreground, mismatch: mismatches / Math.max(1, foreground), inkBoundsDifference: inkA && inkB ? Math.max(...inkA.map((value, index) => Math.abs(value - inkB![index]!))) : null };
    };
    const checks = regions.map(region => ({ svg: compare(pngPixels, svgRaster.pixels, region), screen: compare(pngPixels, screenPixels, region) }));
    const world = (u: number, v: number) => { const dx = (u - .5) * hero.w, dy = (v - .5) * hero.h; return { x: hero.x + hero.w / 2 + Math.cos(hero.rotation) * dx - Math.sin(hero.rotation) * dy, y: hero.y + hero.h / 2 + Math.sin(hero.rotation) * dx + Math.cos(hero.rotation) * dy }; };
    const sample = (pixels: Uint8ClampedArray, u: number, v: number) => { const point = world(u, v), offset = (Math.floor((point.y - box.y) * scale) * width + Math.floor((point.x - box.x) * scale)) * 4; return [...pixels.slice(offset, offset + 4)]; };
    const colors = probes.map(probe => { const alpha = probe.rgba[3]! / 255 * hero.style.opacity; return { expected: [238, 221, 187].map((bg, channel) => Math.round(probe.rgba[channel]! * alpha + bg * (1 - alpha))).concat(255), png: sample(pngPixels, probe.u, probe.v), svg: sample(svgRaster.pixels, probe.u, probe.v), screen: sample(screenPixels, probe.u, probe.v) }; });
    const heroRegion = regions.find(region => region.name === heroId)!, controls = [];
    for (const kind of ['missing', 'mirrored']) {
      const changed = doc.cloneNode(true) as Document, image = changed.querySelector('image')!;
      if (kind === 'missing') image.remove(); else image.setAttribute('transform', `translate(${2 * hero.x + hero.w} 0) scale(-1 1)`);
      const altered = await rasterSvg(new XMLSerializer().serializeToString(changed)); controls.push({ kind, ...compare(pngPixels, altered.pixels, heroRegion) });
    }
    const flatCaps = await rasterSvg(svgText.replaceAll('stroke-linecap="round"', 'stroke-linecap="butt"'));
    const flatCapControl = compare(pngPixels, flatCaps.pixels, regions.find(region => region.type === 'connector')!);
    // Add a real overlapping element and a renderer-only draft, then export only the committed image.
    board.create('rect', { id: 'unselected-overlap', x: hero.x, y: hero.y, w: hero.w, h: hero.h, rotation: hero.rotation, style: { fill: '#ff00ff', strokeWidth: 0 } });
    renderer.applyDiff([{ ...hero, style: { ...hero.style, opacity: 0 } }]);
    const selectionPng = await exporter.create({ format: 'png', selection: [heroId], scale, transparent: true, title: 'Image only' });
    const selectionSvg = await exporter.create({ format: 'svg', selection: [heroId], scale, transparent: true, title: 'Image only' });
    const selectionDoc = new DOMParser().parseFromString(await selectionSvg.text(), 'image/svg+xml');
    const viewBox = selectionDoc.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    const selectionBitmap = await createImageBitmap(selectionPng), selectedCanvas = document.createElement('canvas'); selectedCanvas.width = selectionBitmap.width; selectedCanvas.height = selectionBitmap.height;
    const selectedContext = selectedCanvas.getContext('2d')!; selectedContext.drawImage(selectionBitmap, 0, 0); selectionBitmap.close();
    const selectionSample = (u: number, v: number) => { const point = world(u, v); return [...selectedContext.getImageData(Math.floor((point.x - viewBox[0]!) * scale), Math.floor((point.y - viewBox[1]!) * scale), 1, 1).data]; };
    const selectionColors = probes.map(probe => ({ expected: probe.rgba[3] === 0 ? [0, 0, 0, 0] : probe.rgba.slice(0, 3).concat(Math.round(probe.rgba[3]! * hero.style.opacity)), png: selectionSample(probe.u, probe.v), svg: [] as number[] }));
    const selectionCorner = [...selectedContext.getImageData(0, 0, 1, 1).data];
    const selectionUrl = URL.createObjectURL(selectionSvg), selectedImage = new Image();
    try { selectedImage.src = selectionUrl; await selectedImage.decode(); selectedContext.clearRect(0, 0, selectedCanvas.width, selectedCanvas.height); selectedContext.drawImage(selectedImage, 0, 0, viewBox[2]! * scale, viewBox[3]! * scale); probes.forEach((probe, index) => { selectionColors[index]!.svg = selectionSample(probe.u, probe.v); }); }
    finally { URL.revokeObjectURL(selectionUrl); }
    return { checks, controls, flatCapControl, colors, selectionColors, opaqueAlphaMin, hrefsEmbedded: hrefs.length === 1 && hrefs.every(href => href.startsWith('data:image/png;base64,')), embeddedBytesEqual: embeddedBytes.length === originalBytes.length && embeddedBytes.every((byte, index) => byte === originalBytes[index]), selectedIds: [...selectionDoc.querySelectorAll('[data-element-id]')].map(node => node.getAttribute('data-element-id')), selectionCorner, svgText, pngData: await toData(png), screenRaster, svgRaster: svgRaster.dataUrl, selectionPngData: await toData(selectionPng), documentImage: board.read(heroId) };
  }, { raw, regions, heroId: source.id, probes: source.probes, originalBytes: source.bytes });
  saveData(directory, 'source.png', source.dataUrl); saveData(directory, 'mixed.png', comparison.pngData); saveData(directory, 'screen.png', comparison.screenRaster); saveData(directory, 'svg-raster.png', comparison.svgRaster); saveData(directory, 'selection.png', comparison.selectionPngData); writeFileSync(resolve(directory, 'mixed.svg'), comparison.svgText);
  writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify({ ...comparison, svgText: undefined, pngData: undefined, screenRaster: undefined, svgRaster: undefined, selectionPngData: undefined, pageErrors: errors, tolerance: { channel: 48, edgeOutputPixels: 1, imageMismatch: .02, ellipseMismatch: .02, textAndConnectorMismatch: .18, inkBoundsOutputPixels: 1, colorProbeChannel: 2 }, diagnostic: 'The stricter 2% connector experiment is preserved in strict-connector-before-opaque-alpha-comparison.json. Round caps fixed its 3px geometry error; remaining coverage differences are the existing S4 MSAA/raster tolerance. Flat-cap negative control must still fail the independent 1px ink bound.' }, null, 2));
  expect(comparison.hrefsEmbedded).toBe(true); expect(comparison.embeddedBytesEqual).toBe(true);
  // In particular, alpha-to-coverage ellipse fringes must not make opaque PNGs transparent.
  expect(comparison.opaqueAlphaMin).toBe(255);
  for (const check of comparison.checks) for (const result of [check.svg, check.screen]) {
    expect(result.foreground, `${result.type} foreground`).toBeGreaterThan(100);
    expect(result.mismatch, `${result.type} mismatch`).toBeLessThan(result.type === 'text' || result.type === 'connector' ? .18 : .02);
    expect(result.inkBoundsDifference, `${result.type} ink bounds`).not.toBeNull(); expect(result.inkBoundsDifference!).toBeLessThanOrEqual(1);
  }
  for (const color of comparison.colors) for (const values of [color.png, color.svg, color.screen]) for (let channel = 0; channel < 4; channel++) expect(Math.abs(values[channel]! - color.expected[channel]!)).toBeLessThanOrEqual(2);
  for (const control of comparison.controls) expect(control.mismatch, control.kind).toBeGreaterThan(.2);
  expect(comparison.flatCapControl.inkBoundsDifference).toBeGreaterThan(1);
  expect(comparison.selectedIds).toEqual([source.id]); expect(comparison.selectionCorner).toEqual([0, 0, 0, 0]);
  for (const color of comparison.selectionColors) for (const values of [color.png, color.svg]) for (let channel = 0; channel < 4; channel++) expect(Math.abs(values[channel]! - color.expected[channel]!)).toBeLessThanOrEqual(2);
  expect(comparison.documentImage).toEqual(source.elements.find(element => element.id === source.id)); expect(errors).toEqual([]);
});

test('PNG and embedded SVG retain native alternating-pixel detail after a low-resolution display preview', async ({ page }, testInfo) => {
  test.setTimeout(45_000); const directory = evidenceDirectory(testInfo); await privateBoard(page, 'Original pixel detail');
  const result = await page.evaluate(async () => {
    const source = document.createElement('canvas'); source.width = 2048; source.height = 64; const sourceContext = source.getContext('2d')!;
    for (let x = 0; x < source.width; x++) { sourceContext.fillStyle = x % 2 ? '#ffffff' : '#000000'; sourceContext.fillRect(x, 0, 1, source.height); }
    const blob = await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), 'image/png'));
    const { board, assets, exporter, renderer, session } = window.whiteboard;
    await assets.importFiles([new File([blob], 'original-pixel-detail.png', { type: 'image/png' })]); const element = board.readAll()[0]!;
    board.update(element.id, { x: 0, y: 0, w: 512, h: 16 }); session.setState({ camera: { x: 256, y: 8, zoom: .1 } });
    await renderer.whenReady(); renderer.render();
    const stats = renderer.stats();
    const png = await exporter.create({ format: 'png', scale: 4, padding: 0, transparent: true, title: 'Native detail' });
    const svg = await exporter.create({ format: 'svg', scale: 4, padding: 0, transparent: true, title: 'Native detail' });
    const paint = document.createElement('canvas'); paint.width = 2048; paint.height = 64; const context = paint.getContext('2d')!;
    const bitmap = await createImageBitmap(png); const dimensions = [bitmap.width, bitmap.height]; context.drawImage(bitmap, 0, 0); bitmap.close();
    const pngRow = context.getImageData(0, 32, 2048, 1).data, pngData = paint.toDataURL();
    const url = URL.createObjectURL(svg), image = new Image(); image.src = url; await image.decode(); context.clearRect(0, 0, 2048, 64); context.drawImage(image, 0, 0, 2048, 64); URL.revokeObjectURL(url);
    const svgRow = context.getImageData(0, 32, 2048, 1).data, svgData = paint.toDataURL();
    const check = (pixels: Uint8ClampedArray) => { let error = 0, maxError = 0, contrast = 0; for (let x = 0; x < 2048; x++) { const difference = Math.abs(pixels[x * 4]! - (x % 2 ? 255 : 0)); error += difference; maxError = Math.max(maxError, difference); if (x > 0) contrast += Math.abs(pixels[x * 4]! - pixels[(x - 1) * 4]!); } return { meanError: error / 2048, maxError, adjacentContrast: contrast / 2047, alphaMin: Math.min(...Array.from({ length: 2048 }, (_, x) => pixels[x * 4 + 3]!)) }; };
    // A 64px display thumbnail enlarged back to source size must fail the same detail test.
    const thumbnail = document.createElement('canvas'); thumbnail.width = 64; thumbnail.height = 2; thumbnail.getContext('2d')!.drawImage(source, 0, 0, 64, 2);
    context.clearRect(0, 0, 2048, 64); context.drawImage(thumbnail, 0, 0, 2048, 64); const thumbnailControl = check(context.getImageData(0, 32, 2048, 1).data);
    return { dimensions, preview: stats, png: check(pngRow), svg: check(svgRow), thumbnailControl, pngData, svgData, documentElements: board.readAll().length };
  });
  saveData(directory, 'native-detail.png', result.pngData); saveData(directory, 'native-detail-svg.png', result.svgData);
  writeFileSync(resolve(directory, 'native-detail.json'), JSON.stringify({ ...result, pngData: undefined, svgData: undefined }, null, 2));
  expect(result.dimensions).toEqual([2048, 64]); expect(result.documentElements).toBe(1); expect(result.preview.visibleImages).toBe(1);
  for (const output of [result.png, result.svg]) { expect(output.meanError).toBeLessThanOrEqual(2); expect(output.maxError).toBeLessThanOrEqual(2); expect(output.adjacentContrast).toBeGreaterThanOrEqual(251); expect(output.alphaMin).toBe(255); }
  expect(result.thumbnailControl.meanError).toBeGreaterThan(100); expect(result.thumbnailControl.adjacentContrast).toBeLessThan(10);
});

test('round translucent connector caps and elbow joins preserve one opacity contribution', async ({ page }, testInfo) => {
  const directory = evidenceDirectory(testInfo); await privateBoard(page, 'Round connector opacity');
  const result = await page.evaluate(async () => {
    const { board, exporter } = window.whiteboard;
    board.create('connector', { id: 'round-elbow', style: { stroke: '#2054df', strokeWidth: 12, opacity: .4 }, props: { start: { x: 50, y: 70 }, end: { x: 250, y: 210 }, kind: 'elbow' } });
    const png = await exporter.create({ format: 'png', scale: 4, transparent: true, title: 'Round elbow' });
    const svg = await exporter.create({ format: 'svg', scale: 4, transparent: true, title: 'Round elbow' });
    const doc = new DOMParser().parseFromString(await svg.text(), 'image/svg+xml'), box = doc.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    const bitmap = await createImageBitmap(png), width = bitmap.width, height = bitmap.height;
    const paint = document.createElement('canvas'); paint.width = width; paint.height = height; const context = paint.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); bitmap.close(); const pngPixels = context.getImageData(0, 0, width, height).data, pngData = paint.toDataURL();
    const url = URL.createObjectURL(svg), image = new Image(); image.src = url; await image.decode(); context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0, box[2]! * 4, box[3]! * 4); URL.revokeObjectURL(url);
    const svgPixels = context.getImageData(0, 0, width, height).data, svgData = paint.toDataURL();
    const probes = [{ name: 'start cap', x: 46, y: 70 }, { name: 'start body overlap', x: 53, y: 70 }, { name: 'first round outer join', x: 153, y: 67 }, { name: 'first inner overlap', x: 147, y: 73 }, { name: 'vertical body', x: 150, y: 140 }, { name: 'second outer join', x: 147, y: 213 }, { name: 'end cap', x: 254, y: 210 }, { name: 'arrow/body overlap', x: 220, y: 210 }];
    const colors = probes.map(probe => { const offset = (Math.floor((probe.y - box[1]!) * 4) * width + Math.floor((probe.x - box[0]!) * 4)) * 4; return { name: probe.name, png: [...pngPixels.slice(offset, offset + 4)], svg: [...svgPixels.slice(offset, offset + 4)] }; });
    const different = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => Math.abs(a[ai + 3]! - b[bi + 3]!) > 8 || [0, 1, 2].some(channel => Math.abs(a[ai + channel]! * a[ai + 3]! / 255 - b[bi + channel]! * b[bi + 3]! / 255) > 8);
    const nearby = (a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) => { for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) if (!different(a, ai, b, bi + (y * width + x) * 4)) return true; return false; };
    let foreground = 0, mismatches = 0, maxAlpha = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * 4; maxAlpha = Math.max(maxAlpha, pngPixels[offset + 3]!);
      if (pngPixels[offset + 3]! < 4 && svgPixels[offset + 3]! < 4) continue; foreground++;
      if (different(pngPixels, offset, svgPixels, offset) && (!nearby(pngPixels, offset, svgPixels, offset) || !nearby(svgPixels, offset, pngPixels, offset))) mismatches++;
    }
    return { colors, foreground, mismatch: mismatches / foreground, maxAlpha, pngData, svgData };
  });
  saveData(directory, 'round-translucent.png', result.pngData); saveData(directory, 'round-translucent-svg.png', result.svgData);
  writeFileSync(resolve(directory, 'round-translucent.json'), JSON.stringify({ ...result, pngData: undefined, svgData: undefined, tolerance: { premultipliedChannel: 8, edgeOutputPixels: 1, mismatch: .02, probeChannel: 2 } }, null, 2));
  expect(result.foreground).toBeGreaterThan(1000); expect(result.mismatch).toBeLessThan(.02); expect(result.maxAlpha).toBeLessThanOrEqual(103);
  for (const color of result.colors) for (const values of [color.png, color.svg]) for (let channel = 0; channel < 4; channel++) expect(Math.abs(values[channel]! - [32, 84, 223, 102][channel]!), `${color.name} channel ${channel}`).toBeLessThanOrEqual(2);
});
