import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importExcalidraw, resolveBinding, textBlock } from '@whiteboard/model';
import { evidenceDirectory } from '../evidence';

const genuinePath = resolve('packages/model/test/fixtures/excalidraw/official-app-mixed.excalidraw');
const genuineText = readFileSync(genuinePath, 'utf8');
const simple = (count = 1) => ({ type: 'excalidraw', version: 2, elements: Array.from({ length: count }, (_, i) => ({ id: `source-${i}`, type: 'rectangle', x: 100 + i * 8, y: 100, width: 100, height: 80 })) });
function namedMessageKind(bytes: Buffer): number[] {
  let cursor = 0;
  const uint = () => { let n = 0, shift = 0, value: number; do { value = bytes[cursor++]!; n += (value & 127) * 2 ** shift; shift += 7; } while (value & 128 && cursor < bytes.length); return n; };
  const nameLength = uint(); cursor += nameLength; return [uint(), uint()];
}
async function open(page: Page, title: string) {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('alice'); await page.getByLabel('Password', { exact: true }).fill('browser-test-only-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New board', exact: true }).or(page.getByRole('button', { name: 'Back to boards', exact: true }))).toBeVisible();
  if (await page.getByRole('button', { name: 'Back to boards', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back to boards', exact: true }).click();
  await page.getByRole('button', { name: 'New board', exact: true }).click(); await page.getByLabel('Board name', { exact: true }).fill(title); await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced && !window.whiteboardConnection.provider.hasUnsyncedChanges);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
const values = (page: Page) => page.evaluate(() => window.whiteboard.board.readAll());
async function file(page: Page, text: string, name = 'scene.excalidraw') { await page.getByLabel('Import images', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) }); }
async function drop(page: Page, text: string) {
  await page.evaluate(text => { const transfer = new DataTransfer(); transfer.items.add(new File([text], 'scene.excalidraw', { type: 'application/json' })); document.querySelector('.board-canvas')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 700, clientY: 400 })); }, text);
}
async function pasted(page: Page, text: string) { await page.locator('.board-canvas').focus(); await page.evaluate(text => { const data = new DataTransfer(); data.setData('text/plain', text); document.querySelector('.board-canvas')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, text); }
async function finished(page: Page, count: number) { await expect.poll(async () => (await values(page)).length).toBe(count); await expect(page.getByRole('region', { name: 'Import report' })).toContainText(`${count} acknowledged by the server`); }

test('genuine official file merges with existing content, keeps following arrows and survives reload as one undo step', async ({ page }, info) => {
  await open(page, 'Real Excalidraw import'); await page.evaluate(() => { window.whiteboard.board.create('rect', { id: 'existing', x: -200, y: -200 }); });
  await page.waitForFunction(() => !window.whiteboardConnection!.provider.hasUnsyncedChanges);
  const expected = importExcalidraw(JSON.parse(genuineText), { newId: (() => { let n = 0; return () => 'expected-' + ++n; })(), firstIndex: null });
  const before = await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
  await page.getByRole('button', { name: 'Add images', exact: true }).click(); await file(page, genuineText);
  await expect.poll(async () => (await values(page)).length).toBe(expected.elements.length + 1);
  await expect(page.getByRole('region', { name: 'Import report' })).toContainText(`${expected.elements.length} acknowledged by the server`);
  const imported = (await values(page)).filter(e => e.id !== 'existing');
  expect(imported.map(e => e.type)).toEqual(expected.elements.map(e => e.type));
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(before + 1);
  const connector = imported.find(e => e.type === 'connector' && 'elementId' in e.props.start)!; if (connector.type !== 'connector' || !('elementId' in connector.props.start)) throw new Error('Expected following arrow');
  const targetId = connector.props.start.elementId;
  const first = resolveBinding(connector.props.start, new Map(imported.map(e => [e.id, e])));
  await page.evaluate(id => { const e = window.whiteboard.board.read(id)!; window.whiteboard.board.update(id, { x: e.x + 60 }); }, targetId);
  const moved = await values(page), updated = moved.find(e => e.id === connector.id)!; if (updated.type !== 'connector') throw new Error('Expected connector');
  expect(resolveBinding(updated.props.start, new Map(moved.map(e => [e.id, e]))).x).toBeCloseTo(first.x + 60);
  await page.waitForFunction(() => !window.whiteboardConnection!.provider.hasUnsyncedChanges);
  await page.evaluate(async () => { await window.whiteboard.renderer.whenReady(); window.whiteboard.renderer.render(); });
  const settled = await page.evaluate(() => window.whiteboard.renderer.stats()); expect(settled.pendingTexts).toBe(0); expect(settled.visibleTexts).toBeGreaterThanOrEqual(expected.elements.filter(e => !!textBlock(e)).length);
  const directory = evidenceDirectory(info); writeFileSync(resolve(directory, 'imported.json'), JSON.stringify({ elements: moved, settled }, null, 2)); await page.screenshot({ path: resolve(directory, 'live.png') });
  await page.reload(); await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced); expect(await values(page)).toEqual(moved);
});

test('drop and Excalidraw clipboard paste merge rather than replace, including clipboard text above 8 MiB', async ({ page }) => {
  await open(page, 'Import entry points'); await drop(page, JSON.stringify(simple())); await finished(page, 1);
  const original = await values(page);
  const clipboard = { ...simple(2), type: 'excalidraw/clipboard' }; const text = ' '.repeat(8 * 1024 * 1024 + 1) + JSON.stringify(clipboard);
  await pasted(page, text); await expect.poll(async () => (await values(page)).length).toBe(3); await expect(page.getByRole('region', { name: 'Import report' })).toContainText('2 acknowledged by the server');
  expect((await values(page)).find(e => e.id === original[0]!.id)).toEqual(original[0]);
  await page.locator('.board-canvas').focus(); await page.keyboard.press('ControlOrMeta+z'); expect(await values(page)).toEqual(original);
});

test('original byte cap, viewer guard and predictable storage failure leave source, undo and uploads untouched', async ({ page }, info) => {
  await open(page, 'Import admission'); const before = await values(page); let uploads = 0; page.on('request', req => { if (req.method() === 'POST' && /\/assets$/.test(req.url())) uploads++; });
  const oversized = info.outputPath('oversized.excalidraw'); writeFileSync(oversized, ' '.repeat(50 * 1024 * 1024 + 1));
  await page.getByLabel('Import images', { exact: true }).setInputFiles(oversized); await expect(page.getByRole('alert')).toContainText('50 MiB'); expect(await values(page)).toEqual(before);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.route('**/import-budget', async route => { const response = await route.fetch(); const body = await response.json(); body.limits.maxBoardBytes = 1; await route.fulfill({ json: body }); });
  await file(page, JSON.stringify(simple())); await expect(page.getByRole('alert')).toContainText('storage'); expect(await values(page)).toEqual(before); expect(uploads).toBe(0);
  await page.unroute('**/import-budget'); await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.evaluate(() => { window.whiteboard.readOnly = true; }); await drop(page, JSON.stringify(simple())); await expect(page.getByRole('alert')).toContainText('read-only'); expect(await values(page)).toEqual(before);
});

test('an authenticated viewer cannot import an Excalidraw drop or upload assets', async ({ page, browser }) => {
  const id = await open(page, 'Viewer import boundary');
  const ok = await page.evaluate(async id => (await fetch(`/api/boards/${id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'viewer', role: 'viewer' }) })).ok, id); expect(ok).toBe(true);
  const context = await browser.newContext(), viewer = await context.newPage();
  try {
    await viewer.goto('/'); await viewer.getByLabel('Username', { exact: true }).fill('viewer'); await viewer.getByLabel('Password', { exact: true }).fill('browser-test-only-password'); await viewer.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'New board', exact: true }).or(viewer.getByRole('button', { name: 'Back to boards', exact: true }))).toBeVisible();
    await viewer.goto(`/board/${id}`);
    await viewer.waitForFunction(() => !!window.whiteboard && window.whiteboard.readOnly && !!window.whiteboardConnection?.provider.synced);
    let uploads = 0; viewer.on('request', req => { if (req.method() === 'POST' && /\/assets$/.test(req.url())) uploads++; });
    const before = await values(viewer); await drop(viewer, JSON.stringify(simple())); await expect(viewer.getByRole('alert')).toContainText('read-only');
    expect(await values(viewer)).toEqual(before); expect(uploads).toBe(0); expect(await viewer.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  } finally { await context.close(); }
});

test('full report exposes all skipped reasons with bounded expanded DOM and a usable dismiss button', async ({ page }) => {
  await open(page, 'Import report'); const scene = { ...simple(), elements: [...simple().elements, ...Array.from({ length: 45 }, (_, i) => ({ id: `unsupported-${i}` + 'x'.repeat(5000), type: 'magic', x: 0, y: 0, width: 1, height: 1 }))] };
  await file(page, JSON.stringify(scene)); await finished(page, 1); const notice = page.getByRole('region', { name: 'Import report' }); await notice.getByText('Skipped elements', { exact: true }).click(); expect(await notice.locator('li').count()).toBe(20);
  const downloaded = page.waitForEvent('download'); await notice.getByRole('button', { name: 'Download full import report' }).click(); const report = JSON.parse(readFileSync((await (await downloaded).path())!, 'utf8')); expect(report.skipped).toHaveLength(45); expect(report.skipped[44].id.length).toBeGreaterThan(5000);
  await notice.getByRole('button', { name: 'Dismiss import report' }).click(); await expect(notice).toHaveCount(0);
});

test('image crop and flips use oriented source pixels, deduplicate transforms, and refresh destination after upload', async ({ page }, info) => {
  const boardId = await open(page, 'Import transformed images');
  const fixture = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40; const ctx = canvas.getContext('2d')!;
    for (const [i, color] of ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].entries()) { ctx.fillStyle = color; ctx.fillRect(i % 2 * 40, Math.floor(i / 2) * 20, 40, 20); }
    const bytes = new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg', 1))).arrayBuffer());
    const tiff = new Uint8Array(26), view = new DataView(tiff.buffer); tiff.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 1, true); view.setUint16(10, 0x112, true); view.setUint16(12, 3, true); view.setUint32(14, 1, true); view.setUint16(18, 6, true);
    const app = Uint8Array.from([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, ...tiff]), jpeg = new Uint8Array(bytes.length + app.length); jpeg.set(bytes.subarray(0, 2)); jpeg.set(app, 2); jpeg.set(bytes.subarray(2), 2 + app.length);
    return 'data:image/jpeg;base64,' + btoa(String.fromCharCode(...jpeg));
  });
  // Orientation6 maps source [red,green,blue,yellow] to [blue,red,yellow,green].
  // X flip yields [red,blue,green,yellow]; a middle crop crossing both rows then Y flip yields [yellow,green,blue,red].
  const scene = { type: 'excalidraw', version: 2, files: { pixels: { mimeType: 'image/jpeg', dataURL: fixture } }, elements: [
    { id: 'mirror', type: 'image', x: 100, y: 100, width: 120, height: 240, angle: .25, fileId: 'pixels', scale: [-1, 1] },
    { id: 'duplicate', type: 'image', x: 250, y: 100, width: 120, height: 240, fileId: 'pixels', scale: [-1, 1] },
    { id: 'crop', type: 'image', x: 400, y: 100, width: 120, height: 120, fileId: 'pixels', crop: { x: 0, y: 20, width: 40, height: 40 }, scale: [1, -1] },
  ] };
  let uploads = 0; await page.route('**/assets', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; } uploads++;
    if (uploads === 1) { await page.evaluate(() => { window.whiteboard.board.create('rect', { id: 'during-upload', index: 'b20', x: -200, y: 0 }); }); await page.waitForFunction(() => !window.whiteboardConnection!.provider.hasUnsyncedChanges); }
    await route.continue();
  });
  await file(page, JSON.stringify(scene)); await expect.poll(async () => (await values(page)).length).toBe(4); await expect(page.getByRole('region', { name: 'Import report' })).toContainText('3 acknowledged by the server'); expect(uploads).toBe(2);
  const images = (await values(page)).filter(e => e.type === 'image'); expect(images.every(e => e.index > 'b20')).toBe(true); expect(images[0]).toMatchObject({ x: 100, y: 100, w: 120, h: 240, rotation: .25, props: { naturalW: 40, naturalH: 80 } }); expect(images[0]!.props.assetId).toBe(images[1]!.props.assetId); expect(images[2]).toMatchObject({ props: { naturalW: 40, naturalH: 40 } });
  const pixels = await page.evaluate(async ({ boardId, ids }) => {
    const result = []; for (const id of ids) { const blob = await (await fetch(`/api/boards/${boardId}/assets/${id}`)).blob(), bitmap = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close(); result.push(Array.from({ length: 4 }, (_, i) => [...ctx.getImageData(c.width * (i % 2 ? .75 : .25), c.height * (i >= 2 ? .75 : .25), 1, 1).data])); } return result;
  }, { boardId, ids: [images[0]!.props.assetId, images[2]!.props.assetId] });
  const colors = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 255, 0, 255]];
  for (const [i, color] of colors.entries()) for (let c = 0; c < 4; c++) expect(Math.abs(pixels[0]![i]![c]! - color[c]!)).toBeLessThanOrEqual(4);
  const cropped = [colors[3]!, colors[2]!, colors[1]!, colors[0]!];
  for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) expect(Math.abs(pixels[1]![i]![c]! - cropped[i]![c]!)).toBeLessThanOrEqual(4);
  await page.evaluate(async () => { await window.whiteboard.renderer.whenReady(); window.whiteboard.renderer.render(); });
  const dir = evidenceDirectory(info); writeFileSync(resolve(dir, 'quadrants.json'), JSON.stringify({ pixels, images }, null, 2)); await page.screenshot({ path: resolve(dir, 'image-import.png') });
});

test('split import sends bounded real frames one ACK at a time and retains full local selection', async ({ page }, info) => {
  await open(page, 'Bounded import batches');
  const cap = Number(process.env.WHITEBOARD_TEST_MAX_UPDATE_BYTES ?? 3500);
  await page.route('**/import-budget', async route => { const response = await route.fetch(), body = await response.json(); body.limits.maxUpdateBytes = Math.min(body.limits.maxUpdateBytes, cap); body.limits.maxInboundBytes = Math.min(body.limits.maxInboundBytes, 6000); await route.fulfill({ json: body }); });
  const frames: number[] = []; page.on('websocket', ws => ws.on('framesent', event => { if (typeof event.payload !== 'string') frames.push(event.payload.length); }));
  // The connection already exists; CDP observes its actual outgoing frames without replacing send/ACK handlers.
  const protocol: string[] = [];
  const kind = (bytes: Buffer) => { let cursor = 0; const uint = () => { let n = 0, shift = 0, value: number; do { value = bytes[cursor++]!; n += (value & 127) * 2 ** shift; shift += 7; } while (value & 128 && cursor < bytes.length); return n; }; const nameLength = uint(); cursor += nameLength; return [uint(), uint()]; };
  const cdp = await page.context().newCDPSession(page); await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', event => { if (event.response.opcode === 2) { const bytes = Buffer.from(event.response.payloadData, 'base64'); frames.push(bytes.length); const [type, subtype] = kind(bytes); if (type === 0 && subtype === 2) protocol.push('update'); } });
  cdp.on('Network.webSocketFrameReceived', event => { if (event.response.opcode === 2) { const [type, accepted] = kind(Buffer.from(event.response.payloadData, 'base64')); if (type === 8 && accepted === 1) protocol.push('ack'); } });
  const before = await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
  await file(page, JSON.stringify(simple(80))); await finished(page, 80);
  const state = await page.evaluate(() => ({ local: window.whiteboard.session.getState().selectedIds, wire: window.whiteboardConnection!.provider.awareness!.getLocalState()!.selection, steps: window.whiteboard.board.undoManager.undoStack.length, pending: window.whiteboardConnection!.provider.unsyncedChanges }));
  expect(state.local).toHaveLength(80); expect(state.wire.length).toBeLessThan(80); expect(state.steps).toBeGreaterThan(before + 1); expect(state.pending).toBe(0); expect(frames.length).toBeGreaterThan(1); expect(Math.max(...frames)).toBeLessThanOrEqual(cap);
  expect(protocol).toEqual(Array.from({ length: state.steps - before }, () => ['update', 'ack']).flat());
  await expect(page.getByRole('region', { name: 'Import report' })).toContainText('undo steps');
  writeFileSync(resolve(evidenceDirectory(info), 'frame-sizes.json'), JSON.stringify({ frames, protocol, state, cap }, null, 2)); await cdp.detach();
  await page.locator('.board-canvas').focus(); for (let i = 0; i < state.steps - before; i++) await page.keyboard.press('ControlOrMeta+z'); await expect.poll(async () => (await values(page)).length).toBe(0);
});

test('a later budget failure retains acknowledged batches with truthful count, selection and undo', async ({ page }) => {
  await open(page, 'Partial import interruption'); let calls = 0;
  await page.route('**/import-budget', async route => {
    if (++calls >= 4) { await route.fulfill({ status: 503, json: { error: 'Budget service unavailable' } }); return; }
    const response = await route.fetch(), body = await response.json(); body.limits.maxUpdateBytes = Math.min(body.limits.maxUpdateBytes, 1800); await route.fulfill({ json: body });
  });
  await file(page, JSON.stringify(simple(20))); await expect(page.getByRole('alert')).toContainText('Budget service unavailable');
  const added = (await values(page)).length; expect(added).toBeGreaterThan(0); expect(added).toBeLessThan(20);
  await expect(page.getByRole('region', { name: 'Import report' })).toContainText(`Imported ${added} elements`); await expect(page.getByRole('region', { name: 'Import report' })).toContainText(`${added} acknowledged by the server`);
  expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds.length)).toBe(added); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await page.locator('.board-canvas').focus(); await page.keyboard.press('ControlOrMeta+z'); expect(await values(page)).toEqual([]);
});

test('image-containing imports preflight quota and every later element before decoding or uploading', async ({ page }, info) => {
  await open(page, 'Image admission ordering');
  await page.evaluate(() => { window.whiteboard.board.create('rect', { id: 'existing' }); }); await page.waitForFunction(() => !window.whiteboardConnection!.provider.hasUnsyncedChanges);
  const baseline = await page.evaluate(() => ({ values: window.whiteboard.board.readAll(), undo: window.whiteboard.board.undoManager.undoStack.length }));
  let uploads = 0; page.on('request', request => { if (request.method() === 'POST' && /\/assets$/.test(request.url())) uploads++; });
  await page.evaluate(() => {
    const original = window.createImageBitmap; Object.assign(window, { importDecodes: 0 });
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => { (window as unknown as { importDecodes: number }).importDecodes++; return original(...args); }) as typeof createImageBitmap;
  });
  await page.route('**/import-budget', async route => { const response = await route.fetch(), body = await response.json(); body.limits.maxBoardBytes = 1; await route.fulfill({ json: body }); });
  await file(page, genuineText); await expect(page.getByRole('alert')).toContainText('storage');
  expect(uploads).toBe(0); expect(await page.evaluate(() => (window as unknown as { importDecodes: number }).importDecodes)).toBe(0);
  await page.unroute('**/import-budget'); await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#dc2525'; ctx.fillRect(0, 0, 4, 4); return canvas.toDataURL('image/png'); });
  await page.route('**/import-budget', async route => { const response = await route.fetch(), body = await response.json(); body.limits.maxUpdateBytes = Math.min(body.limits.maxUpdateBytes, 2000); await route.fulfill({ json: body }); });
  for (const kind of ['label', 'points']) {
    const late = kind === 'label' ? { id: 'late', type: 'text', x: 20, y: 0, width: 200, height: 30, text: 'x'.repeat(5000), fontFamily: 1 } : { id: 'late', type: 'freedraw', x: 20, y: 0, width: 1999, height: 1, points: Array.from({ length: 2000 }, (_, i) => [i, i % 2]), pressures: Array(2000).fill(.5) };
    const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: 'pixels', x: 0, y: 0, width: 4, height: 4 }, late], files: { pixels: { mimeType: 'image/png', dataURL: image } } };
    const converted = importExcalidraw(scene, { newId: () => crypto.randomUUID(), firstIndex: null }); expect(converted.elements).toHaveLength(2); expect(converted.report.skipped).toEqual([]);
    await file(page, JSON.stringify(scene)); await expect(page.getByRole('alert')).toBeVisible();
    expect(uploads).toBe(0); expect(await page.evaluate(() => (window as unknown as { importDecodes: number }).importDecodes)).toBe(0);
    expect(await values(page)).toEqual(baseline.values); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(baseline.undo);
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  }
  writeFileSync(resolve(evidenceDirectory(info), 'image-preflight.json'), JSON.stringify({ uploads, baseline, decodes: 0, probes: ['genuine quota', 'late label', 'late points'] }, null, 2));
});

test('a real upload failure leaves no imported document prefix or undo gesture', async ({ page }, info) => {
  await open(page, 'Import upload failure'); const baseline = await values(page), undo = await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length); let uploads = 0;
  await page.route('**/assets', async route => { if (route.request().method() !== 'POST') { await route.continue(); return; } uploads++; await route.fulfill({ status: 503, json: { error: 'Controlled asset failure' } }); });
  await file(page, genuineText); await expect(page.getByRole('alert')).toContainText('Controlled asset failure'); expect(uploads).toBe(1);
  expect(await values(page)).toEqual(baseline); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(undo);
  await expect(page.getByRole('region', { name: 'Import report' })).toContainText('Imported 0 elements');
  writeFileSync(resolve(evidenceDirectory(info), 'upload-failure.json'), JSON.stringify({ uploads, baseline, undo }));
});

test('socket close while a positive ACK is withheld stops later batches and reconnects only the bounded suffix', async ({ page }, info) => {
  let armed = false, withheld = false, generation = 0;
  const events: { direction: string; generation: number; kind: number[]; bytes: number }[] = [];
  await page.routeWebSocket('**/collaboration*', client => {
    const server = client.connectToServer(), current = ++generation;
    client.onMessage(message => { if (typeof message !== 'string') events.push({ direction: 'out', generation: current, kind: namedMessageKind(message), bytes: message.length }); server.send(message); });
    server.onMessage(message => {
      const kind = typeof message === 'string' ? [] : namedMessageKind(message);
      if (typeof message !== 'string') events.push({ direction: 'in', generation: current, kind, bytes: message.length });
      if (armed && !withheld && kind[0] === 8 && kind[1] === 1) {
        withheld = true; armed = false;
        // This is a real accepted server update; only its acknowledgment is blocked at the proxy.
        void Promise.all([server.close({ code: 1001, reason: 'Controlled import interruption' }), client.close({ code: 1001, reason: 'Controlled import interruption' })]); return;
      }
      client.send(message);
    });
  });
  await open(page, 'Import ACK interruption');
  const initialGeneration = generation, actor = await page.evaluate(() => window.whiteboard.board.actor);
  await page.route('**/import-budget', async route => { const response = await route.fetch(), body = await response.json(); body.limits.maxUpdateBytes = Math.min(body.limits.maxUpdateBytes, 2000); body.limits.maxInboundBytes = Math.min(body.limits.maxInboundBytes, 6000); await route.fulfill({ json: body }); });
  events.length = 0; armed = true;
  await file(page, JSON.stringify(simple(20))); await expect(page.getByRole('alert')).toContainText('connection closed');
  const imported = (await values(page)).length; expect(imported).toBeGreaterThan(0); expect(imported).toBeLessThan(20); expect(withheld).toBe(true);
  await expect(page.getByRole('region', { name: 'Import report' })).toContainText(`Imported ${imported} elements`);
  expect(events.filter(event => event.direction === 'out' && event.kind[0] === 0 && event.kind[1] === 2)).toHaveLength(1);
  await page.waitForFunction(() => !!window.whiteboardConnection?.provider.synced && !window.whiteboardConnection.provider.hasUnsyncedChanges);
  expect(await values(page)).toHaveLength(imported); expect(await page.evaluate(() => window.whiteboard.session.getState().selectedIds.length)).toBe(imported);
  expect(events.filter(event => event.direction === 'out' && event.kind[0] === 0 && event.kind[1] === 2)).toHaveLength(1);
  const reconnect = events.filter(event => event.direction === 'out' && event.generation > initialGeneration && event.kind[0] === 0 && event.kind[1] === 1);
  expect(reconnect.length).toBeGreaterThan(0); expect(Math.max(...reconnect.map(event => event.bytes))).toBeLessThanOrEqual(2000);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  expect(await page.evaluate(() => window.whiteboard.board.actor)).toBe(actor); expect(await page.evaluate(() => window.whiteboard.readOnly)).toBe(false);
  writeFileSync(resolve(evidenceDirectory(info), 'withheld-ack.json'), JSON.stringify({ events, imported, generation, withheld, pendingAfterReconnect: await page.evaluate(() => window.whiteboardConnection!.provider.unsyncedChanges) }, null, 2));
  // Counts are a historical stopped-import result; a later reconnect must not leave a false live waiting claim.
  await expect(page.getByRole('region', { name: 'Import report' })).not.toContainText('awaiting sync');
  await expect(page.getByRole('region', { name: 'Import report' })).toContainText(`${imported} added locally, not acknowledged before the import stopped`);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click(); await file(page, JSON.stringify(simple()));
  await expect.poll(async () => (await values(page)).length).toBe(imported + 1); await expect(page.getByRole('region', { name: 'Import report' })).toContainText('1 acknowledged by the server');
});
