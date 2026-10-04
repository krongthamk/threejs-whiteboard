import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';

const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));
const spikesRoot = fileURLToPath(new URL('../', import.meta.url));
const buildDirectory = fileURLToPath(new URL('./dist/media/', import.meta.url));
await mkdir(artifacts, { recursive: true });
await build({ configFile: false, root: spikesRoot,
  publicDir: fileURLToPath(new URL('../../packages/app/public', import.meta.url)), resolve: { alias: {
  '@whiteboard/model': fileURLToPath(new URL('../../packages/model/src/index.ts', import.meta.url)),
  '@whiteboard/renderer': fileURLToPath(new URL('../../packages/renderer/src/index.ts', import.meta.url)),
} }, build: { outDir: buildDirectory, emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) } } });
let browser, server;
try {
  server = await preview({ configFile: false, root: spikesRoot, build: { outDir: buildDirectory }, preview: { host: '127.0.0.1', port: 4174, strictPort: true } });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { const url = route.request().url(); if (/^https?:/.test(url) && new URL(url).hostname !== '127.0.0.1') { externalRequests.push(url); return route.abort(); } return route.continue(); });
  await page.goto('http://127.0.0.1:4174/renderer/'); await page.waitForFunction(() => window.rendererBenchmark);
  const checks = await page.evaluate(async () => {
    const { createRenderer, fixture } = window.rendererBenchmark;
    const base = fixture({ name: 'source', shapes: 1, strokes: 0, texts: 0 })[0];
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:360px;height:240px;position:fixed;left:0;top:0;z-index:10'; document.body.append(canvas);
    const source = document.createElement('canvas'); source.width = 1024; source.height = 512;
    const paint = source.getContext('2d');
    paint.fillStyle = '#ff0000'; paint.fillRect(0, 0, 512, 256); paint.fillStyle = '#00ff00'; paint.fillRect(512, 0, 512, 256);
    paint.fillStyle = '#0000ff'; paint.fillRect(0, 256, 512, 256); paint.fillStyle = '#ffff00'; paint.fillRect(512, 256, 512, 256);
    // A high-frequency source feature that a 64px display texture cannot preserve.
    for (let x = 0; x < 1024; x++) { paint.fillStyle = x % 2 ? '#ffffff' : '#000000'; paint.fillRect(x, 240, 1, 32); }
    const imageUrl = source.toDataURL(), resolved = [];
    const alphaSource = document.createElement('canvas'); alphaSource.width = alphaSource.height = 64;
    const alphaPaint = alphaSource.getContext('2d'); alphaPaint.fillStyle = 'rgba(255,0,0,.5)'; alphaPaint.fillRect(0, 0, 64, 64); const alphaUrl = alphaSource.toDataURL();
    const renderer = createRenderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', pixelRatio: 1, background: '#ffffff', maxDisplayImageSize: 64,
      imageLoadTimeoutMs: 120, resolveAsset: id => { resolved.push(id); if (id === 'never') return new Promise(() => {}); if (id === 'bad') return 'data:application/octet-stream;base64,AA=='; return id === 'alpha' ? alphaUrl : imageUrl; } });
    renderer.resize(360, 240); renderer.setCamera({ x: 180, y: 120, zoom: 1 });
    const image = { ...base, id: 'picture', type: 'image', index: 'a1', x: 40, y: 40, w: 256, h: 128, rotation: 0,
      style: { ...base.style, opacity: 1, strokeWidth: 0 }, props: { assetId: 'source', naturalW: 1024, naturalH: 512 } };
    renderer.setElements([image]); await renderer.whenReady(); renderer.render();
    const imageGroup = renderer.layers.shapes.children.find(child => child.name === 'images');
    const mesh = imageGroup.children[0];
    const displayWidth = mesh.material.map.image.width, displayTexture = mesh.material.map.uuid;
    const screenPixel = (x, y) => { renderer.render(); const gl = renderer.webgl.getContext(), bytes = new Uint8Array(4); gl.readPixels(x, 240 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return [...bytes]; };
    const orientationPixels = [screenPixel(60, 60), screenPixel(260, 60), screenPixel(60, 150), screenPixel(260, 150)];
    const pixels = async blob => { const bitmap = await createImageBitmap(blob), output = document.createElement('canvas'); output.width = bitmap.width; output.height = bitmap.height; const context = output.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close(); return { output, context }; };
    const exported = await renderer.exportPng({ bounds: { x: 40, y: 40, w: 256, h: 128 }, scale: 4 });
    const full = await pixels(exported);
    const stripePixels = [0, 1, 2, 3].map(x => [...full.context.getImageData(x + 100, 250, 1, 1).data]);
    const restoredThumbnail = mesh.material.map?.uuid === displayTexture && mesh.material.map.image.width === 64;
    const imageCopy = { ...image, id: 'copy', index: 'a2', x: 310, y: 100, w: 30, h: 30 };
    renderer.applyDiff([imageCopy]); await renderer.whenReady(); renderer.render();
    const copiesShareTexture = imageGroup.children.length === 2 && imageGroup.children[0].material.map === imageGroup.children[1].material.map;
    const blue = { ...base, id: 'blue', index: 'a0', x: 0, y: 0, w: 360, h: 240, rotation: 0, style: { ...base.style, fill: '#0000ff', strokeWidth: 0 } };
    renderer.setElements([blue, { ...image, style: { ...image.style, opacity: .5 } }]); await renderer.whenReady();
    const opacityScreen = screenPixel(60, 60), opacityExport = await pixels(await renderer.exportPng({ bounds: { x: 0, y: 0, w: 360, h: 240 }, scale: 1 }));
    const opacityPng = [...opacityExport.context.getImageData(60, 60, 1, 1).data];
    const green = { ...blue, id: 'green', index: 'a2', style: { ...blue.style, opacity: .5, fill: '#00ff00' } };
    renderer.applyDiff([green]); await renderer.whenReady();
    const mixedOrderPixel = screenPixel(60, 60);
    renderer.setElements([{ ...image, rotation: Math.PI / 2 }]); await renderer.whenReady();
    const rotatedTop = screenPixel(200, 40), rotatedBottom = screenPixel(120, 170);
    renderer.setElements([{ ...image, props: { assetId: 'alpha', naturalW: 64, naturalH: 64 } }]); await renderer.whenReady();
    const alphaPng = await pixels(await renderer.exportPng({ bounds: { x: 40, y: 40, w: 256, h: 128 }, scale: 1, transparent: true }));
    const sourceAlphaPixel = [...alphaPng.context.getImageData(100, 50, 1, 1).data];
    const textureCountBeforePan = renderer.webgl.info.memory.textures;
    renderer.setCamera({ x: 100000, y: 100000, zoom: 1 }); renderer.render();
    const releasedOffscreenTextures = renderer.webgl.info.memory.textures < textureCountBeforePan;
    renderer.setCamera({ x: 180, y: 120, zoom: 1 }); await renderer.whenReady(); renderer.render();
    const returnsFromOffscreen = renderer.stats().visibleImages === 1 && renderer.stats().imageErrors === 0 && imageGroup.children[0].material.map !== null;
    const note = { ...base, id: 'note', type: 'sticky', index: 'a0', x: 10, y: 10, w: 110, h: 70, rotation: .2, props: { text: '', align: 'left', autoSize: false } };
    renderer.setElements([note, image]); await renderer.whenReady();
    const documentExport = new Uint8Array(await (await renderer.exportPng({ bounds: { x: 0, y: 0, w: 360, h: 240 } })).arrayBuffer());
    const peers = Array.from({ length: 40 }, (_, i) => ({ clientId: i, name: `Peer ${i}`, color: i % 2 ? '#2563eb' : '#be123c', cursor: { x: 10 + i % 8 * 40, y: 20 + Math.floor(i / 8) * 40 }, selection: ['picture'], editingTextId: i === 0 ? 'note' : null }));
    renderer.setPresence(peers); renderer.render();
    const start = performance.now(); while (renderer.stats().pendingPresenceLabels && performance.now() - start < 15000) { await new Promise(requestAnimationFrame); renderer.render(); }
    const labelStats = renderer.stats();
    const stableIds = renderer.layers.presence.children.map(peer => peer.uuid);
    const stableGeometries = renderer.layers.presence.children.map(peer => peer.children.find(child => child.geometry)?.geometry?.uuid);
    for (let i = 0; i < 30; i++) renderer.setPresence(peers.map(peer => ({ ...peer, cursor: { x: peer.cursor.x + i / 10, y: peer.cursor.y } })));
    renderer.render();
    const reusedPeers = stableIds.every((id, i) => renderer.layers.presence.children[i].uuid === id);
    const reusedFrames = stableGeometries.every((id, i) => renderer.layers.presence.children[i].children.find(child => child.geometry)?.geometry?.uuid === id);
    const previousCursorX = renderer.layers.presence.children[0].children[0].position.x;
    for (let i = 0; i < 800; i++) renderer.setPresence(peers.map(peer => ({ ...peer, cursor: { x: peer.cursor.x + i, y: peer.cursor.y } })));
    const deferredUntilRender = renderer.layers.presence.children[0].children[0].position.x === previousCursorX;
    renderer.render();
    const coalescedPresence = deferredUntilRender && renderer.layers.presence.children[0].children[0].position.x === peers[0].cursor.x + 799;
    const presenceExport = new Uint8Array(await (await renderer.exportPng({ bounds: { x: 0, y: 0, w: 360, h: 240 } })).arrayBuffer());
    const presenceExcluded = documentExport.length === presenceExport.length && documentExport.every((byte, i) => byte === presenceExport[i]);
    renderer.setPresence([]); renderer.render();
    const clearedPresence = renderer.layers.presence.children.length === 0 && renderer.stats().presencePeers === 0;
    const memoryBeforeCycles = { ...renderer.webgl.info.memory };
    for (let i = 0; i < 3; i++) { renderer.setPresence(peers); renderer.render(); renderer.setPresence([]); renderer.render(); }
    const memoryAfterCycles = { ...renderer.webgl.info.memory };
    const noPresenceGeometryGrowth = memoryAfterCycles.geometries === memoryBeforeCycles.geometries;
    renderer.setElements([{ ...image, props: { ...image.props, assetId: 'never' } }]);
    const failureStart = performance.now(); let timeoutError = '';
    try { await renderer.whenReady(); } catch (error) { timeoutError = error.message; }
    const timeoutMs = performance.now() - failureStart, timedOut = renderer.stats().imageErrors === 1 && renderer.stats().pendingImages === 0 && !!renderer.getImageError(image.id);
    renderer.setElements([{ ...image, props: { ...image.props, assetId: 'bad' } }]); let decodeError = '';
    try { await renderer.whenReady(); } catch (error) { decodeError = error.message; }
    renderer.setElements([{ ...image, x: 100000 }]); await renderer.whenReady();
    const offscreenImages = renderer.stats();
    renderer.setElements([{ ...image, props: { ...image.props, assetId: 'never' } }]); renderer.render(); renderer.dispose();
    await new Promise(resolve => setTimeout(resolve, 160));
    const destroyedPending = renderer.stats().pendingImages === 0 && renderer.stats().imageInstances === 0;
    canvas.remove();
    return { displayWidth, orientationPixels, fullExportSize: [full.output.width, full.output.height], stripePixels, restoredThumbnail, copiesShareTexture,
      opacityScreen, opacityPng, mixedOrderPixel, rotatedTop, rotatedBottom, sourceAlphaPixel, releasedOffscreenTextures, returnsFromOffscreen, labelStats, reusedPeers, reusedFrames, presenceExcluded, clearedPresence,
      noPresenceGeometryGrowth, memoryBeforeCycles, memoryAfterCycles, coalescedPresence, timeoutError, timeoutMs, timedOut, decodeError, destroyedPending,
      offscreenNoImageAllocation: offscreenImages.imageInstances === 0 && offscreenImages.pendingImages === 0, resolverCalls: resolved.length,
      fullExportPng: full.output.toDataURL() };
  });
  const expected = (actual, values, tolerance = 2) => actual.every((value, i) => Math.abs(value - values[i]) <= tolerance);
  const assertions = {
    thumbnail64: checks.displayWidth === 64,
    correctImageOrientation: [[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,0,255]].every((value, i) => expected(checks.orientationPixels[i], value)),
    originalResolutionExport: checks.fullExportSize[0] === 1024 && checks.fullExportSize[1] === 512 && checks.stripePixels.every((value, i) => expected(value, i % 2 ? [255,255,255,255] : [0,0,0,255], 4)),
    restoredThumbnail: checks.restoredThumbnail, copiesShareTexture: checks.copiesShareTexture,
    cssOpacityAndOrdering: expected(checks.opacityScreen, [128,0,128,255]) && expected(checks.opacityPng, [128,0,128,255]) && expected(checks.mixedOrderPixel, [64,128,64,255]),
    rotationWorks: expected(checks.rotatedTop, [255,0,0,255]) && expected(checks.rotatedBottom, [255,255,0,255]),
    sourceAlphaSurvivesExport: expected(checks.sourceAlphaPixel, [255,0,0,128]), releasedOffscreenTextures: checks.releasedOffscreenTextures, returnsFromOffscreen: checks.returnsFromOffscreen,
    fortyPeersAndSyncedLabels: checks.labelStats.presencePeers === 40 && checks.labelStats.presenceLabels === 41 && checks.labelStats.pendingPresenceLabels === 0 && checks.labelStats.presenceErrors === 0,
    reusedPeers: checks.reusedPeers, reusedFrames: checks.reusedFrames, coalescedPresence: checks.coalescedPresence, presenceExcluded: checks.presenceExcluded, clearedPresence: checks.clearedPresence,
    noPresenceGeometryGrowth: checks.noPresenceGeometryGrowth, boundedImageFailure: checks.timedOut && checks.timeoutMs < 1000 && checks.timeoutError.includes('120 ms'),
    invalidImageRejects: !!checks.decodeError, offscreenNoImageAllocation: checks.offscreenNoImageAllocation, destroyedPending: checks.destroyedPending,
  };
  await writeFile(`${artifacts}/media-full-source-export.png`, Buffer.from(checks.fullExportPng.split(',')[1], 'base64')); delete checks.fullExportPng;
  let benchmark = null;
  if (process.env.MEDIA_BENCHMARK === '1') {
    console.log('MEDIA_BENCHMARK_START');
    benchmark = await page.evaluate(async () => {
      const { createRenderer, fixture } = window.rendererBenchmark;
      const canvas = document.querySelector('canvas'); window.rendererBenchmark.renderer.dispose();
      const source = document.createElement('canvas'); source.width = source.height = 256;
      const paint = source.getContext('2d'); paint.fillStyle = '#2563eb'; paint.fillRect(0, 0, 256, 256); paint.fillStyle = '#fef3c7'; paint.fillRect(20, 20, 160, 120);
      const url = source.toDataURL();
      const renderer = createRenderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', pixelRatio: 1, resolveAsset: () => url });
      renderer.resize(1440, 928);
      const elements = fixture({ name: 'media-mixed', shapes: 5000, strokes: 2000, texts: 500 }), base = elements[0];
      for (let i = 0; i < 16; i++) elements.push({ ...base, type: 'image', id: `media-${i}`, index: `a1${String(i).padStart(2, '0')}V`, x: 100 + i % 8 * 200, y: 100 + Math.floor(i / 8) * 700, w: 80, h: 80,
        props: { assetId: `asset-${i}`, naturalW: 256, naturalH: 256 } });
      const peers = Array.from({ length: 40 }, (_, i) => ({ clientId: i, name: `Collaborator ${i}`, color: ['#2563eb', '#be123c', '#15803d'][i % 3], cursor: { x: 120 + i % 10 * 155, y: 160 + Math.floor(i / 10) * 185 }, selection: [`shape-${i * 100}`], editingTextId: `text-${i}` }));
      const camera = i => renderer.setCamera({ x: 900 + Math.sin(i / 70) * 24, y: 500 + Math.cos(i / 95) * 18, zoom: .76 + Math.sin(i / 150) * .01 });
      renderer.setElements(elements); camera(0); await renderer.whenReady(); renderer.setPresence(peers); renderer.render();
      const frame = () => new Promise(requestAnimationFrame), readyStart = performance.now();
      while (renderer.stats().pendingPresenceLabels && performance.now() - readyStart < 15000) { await frame(); renderer.render(); }
      for (let i = 0; i < 90; i++) { await frame(); camera(i); renderer.render(); }
      const intervals = [], cpu = []; let previous = await frame(), minVisibleTexts = Infinity;
      for (let i = 0; i < 600; i++) {
        const now = await frame(); intervals.push(now - previous); previous = now;
        const start = performance.now(); camera(i);
        renderer.setPresence(peers.map(peer => ({ ...peer, cursor: { x: peer.cursor.x + Math.sin(i / 40) * 15, y: peer.cursor.y + Math.cos(i / 45) * 10 } })));
        renderer.render(); cpu.push(performance.now() - start); minVisibleTexts = Math.min(minVisibleTexts, renderer.stats().visibleTexts);
      }
      const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
      const gl = renderer.webgl.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = { fps: 1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length), frameMs: { median: quantile(intervals, .5), p95: quantile(intervals, .95), max: Math.max(...intervals) },
        updateAndRenderCpuMs: { median: quantile(cpu, .5), p95: quantile(cpu, .95), max: Math.max(...cpu) }, frames: 600, warmupFrames: 90,
        minVisibleTexts, presenceSnapshotsPerSecond: 60, changedPeersPerSnapshot: 40, stats: renderer.stats(), viewport: { width: 1440, height: 928, dpr: renderer.webgl.getPixelRatio() }, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
      result.passed = result.fps >= 55 && minVisibleTexts === 500 && result.stats.presencePeers === 40 && result.stats.presenceLabels === 80 && result.stats.pendingPresenceLabels === 0 && result.stats.presenceErrors === 0 && result.stats.visibleImages === 16 && result.stats.imageErrors === 0;
      return result;
    });
    await page.screenshot({ path: `${artifacts}/media-mixed-40-peers.png` });
  }
  const report = { timestamp: new Date().toISOString(), browserVersion: browser.version(), headless: true, productionBuild: true,
    hardware: { model: cpus()[0]?.model, logicalCores: cpus().length, memoryGiB: totalmem() / 1024 ** 3 }, assertions, checks, benchmark, errors, externalRequests,
    passed: Object.values(assertions).every(Boolean) && (!benchmark || benchmark.passed) && errors.length === 0 && externalRequests.length === 0 };
  await writeFile(`${artifacts}/${benchmark ? 'media-presence-results' : 'media-presence-checks'}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log('MEDIA_CHECKS', JSON.stringify({ passed: report.passed, assertions, benchmark, errors, externalRequests }));
  if (!report.passed) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve()); }
