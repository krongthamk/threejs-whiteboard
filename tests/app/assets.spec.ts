import { test, expect, type Page } from '@playwright/test';
import { bindToElement, contentBounds, createElement, resolveBinding, type Element } from '@whiteboard/model';

const password = 'browser-test-only-password';
async function signIn(page: Page, username = 'alice') {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New board', exact: true }).or(page.getByRole('button', { name: 'Back to boards', exact: true }))).toBeVisible();
}
async function newBoard(page: Page, title: string) {
  if (await page.getByRole('button', { name: 'Back to boards', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back to boards', exact: true }).click();
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard?.assets && !!window.whiteboardConnection?.provider.synced);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
async function image(page: Page, width: number, height: number, type = 'image/png') {
  return page.evaluate(async ({ width, height, type }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!; context.fillStyle = '#da382b'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#1d5cdd'; context.fillRect(width / 2, 0, width / 2, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Fixture encoding failed')), type));
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type };
  }, { width, height, type });
}
type ImageBytes = { bytes: number[]; type: string };
async function drop(page: Page, files: ImageBytes[], position = { x: 800, y: 420 }) {
  await page.evaluate(({ files, position }) => {
    const transfer = new DataTransfer(); files.forEach((file, index) => transfer.items.add(new File([new Uint8Array(file.bytes)], `image-${index}`, { type: file.type })));
    document.querySelector('.board-canvas')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: position.x, clientY: position.y }));
  }, { files, position });
}
const contents = (page: Page) => page.evaluate(() => window.whiteboard.board.readAll());
async function clipboardText(page: Page, text: string) { await page.evaluate(text => navigator.clipboard.writeText(text), text); await page.keyboard.press('Meta+v'); }
async function clearError(page: Page) { const button = page.getByRole('button', { name: 'Dismiss error', exact: true }); if (await button.isVisible()) await button.click(); }

test.beforeEach(async ({ context, page }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); await signIn(page); });

test('drop preserves PNG/JPEG/WebP bytes and dimensions; a whole batch is one undo gesture', async ({ page }) => {
  const boardId = await newBoard(page, 'Original image bytes');
  const files = await Promise.all([image(page, 1200, 700), image(page, 340, 160, 'image/jpeg'), image(page, 160, 220, 'image/webp')]);
  const before = await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length);
  await drop(page, files);
  await expect.poll(async () => (await contents(page)).length).toBe(3);
  const elements = await contents(page);
  expect(elements.map(element => element.type)).toEqual(['image', 'image', 'image']);
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!; if (element.type !== 'image') throw new Error('Expected imported image');
    const response = await page.request.get(`/api/boards/${boardId}/assets/${element.props.assetId}`);
    expect(response.status()).toBe(200); expect([...await response.body()]).toEqual(files[i]!.bytes);
    expect(element.w).toBeLessThanOrEqual(600); expect(element.h).toBeLessThanOrEqual(450);
    expect(element.w / element.h).toBeCloseTo(element.props.naturalW / element.props.naturalH, 10);
    expect(Object.keys(element.props).sort()).toEqual(['assetId', 'naturalH', 'naturalW']);
  }
  expect(elements[0]).toMatchObject({ props: { naturalW: 1200, naturalH: 700 } });
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(before + 1);
  await page.keyboard.press('Meta+z'); expect(await contents(page)).toEqual([]);
  await page.keyboard.press('Meta+Shift+z'); expect(await contents(page)).toEqual(elements);
  await page.evaluate(() => window.whiteboard.renderer.whenReady());
  expect(await page.evaluate(() => window.whiteboard.renderer.stats().visibleImages)).toBe(3);
});

test('native clipboard image paste imports pixels, while a dialog input retains native paste', async ({ page }) => {
  await newBoard(page, 'Native image clipboard'); const file = await image(page, 180, 120);
  await page.evaluate(async file => navigator.clipboard.write([new ClipboardItem({ [file.type]: new Blob([new Uint8Array(file.bytes)], { type: file.type }) })]), file);
  await page.keyboard.press('Meta+v');
  await expect.poll(async () => (await contents(page)).length).toBe(1);
  expect((await contents(page))[0]).toMatchObject({ type: 'image', props: { naturalW: 180, naturalH: 120 } });
  const before = await contents(page);
  await page.getByRole('button', { name: 'Rename board', exact: true }).click();
  const input = page.getByLabel('Board name', { exact: true }); await input.fill(''); await input.focus();
  await clipboardText(page, 'Native pasted board title'); await expect(input).toHaveValue('Native pasted board title');
  expect(await contents(page)).toEqual(before);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Native pasted board title', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+z'); expect(await contents(page)).toEqual([]);
});

test('native mixed selection copy remaps bindings and shared image refs across private boards', async ({ page, browser }) => {
  const sourceId = await newBoard(page, 'Clipboard source'), pixels = await image(page, 220, 150); await drop(page, [pixels]);
  await expect.poll(async () => (await contents(page)).length).toBe(1);
  const imported = (await contents(page))[0]!; if (imported.type !== 'image') throw new Error('Expected imported image');
  const shape = createElement('rect', { id: 'copy-shape', x: -320, y: -100, w: 180, h: 90, rotation: .4, index: 'a1' });
  const outside = createElement('ellipse', { id: 'external-shape', x: 300, y: 120, index: 'a2' });
  const stroke = createElement('stroke', { id: 'copy-stroke', index: 'a3', props: { points: [-250, 30, .2, -100, 120, .9, 40, 90, .6], simplified: true } });
  const connector = createElement('connector', { id: 'copy-connector', index: 'a4', props: { start: bindToElement(shape, 1, .5), end: bindToElement(outside, 0, .5), kind: 'elbow' } });
  const secondImage = { ...imported, id: 'copy-image-again', index: 'a5', x: 80, y: -180 };
  await page.evaluate(values => {
    const { board, session } = window.whiteboard; board.transact(() => { for (const value of values) board.add(value); });
    // Move the target after binding, so copy must capture the current endpoint rather than its old fallback.
    board.update('external-shape', { y: 200 }); session.setState({ selectedIds: board.readAll().filter(element => element.id !== 'external-shape').map(element => element.id) });
  }, [shape, outside, stroke, connector, secondImage]);
  await page.keyboard.press('Meta+c');
  const text = await page.evaluate(() => navigator.clipboard.readText()), copied = JSON.parse(text) as { elements: Element[] };
  expect(copied.elements).toHaveLength(5); expect(text).not.toContain('data:image'); expect(text).not.toContain('blob:');
  const copiedConnector = copied.elements.find(element => element.type === 'connector')!;
  if (copiedConnector.type !== 'connector') throw new Error('Expected connector');
  expect(copiedConnector.props.end).toEqual({ x: 300, y: 250 });
  const targetId = await newBoard(page, 'Clipboard destination');
  await page.evaluate(() => { window.whiteboard.board.create('sticky', { id: 'existing' }); window.whiteboard.session.setState({ camera: { x: 700, y: -250, zoom: 1 } }); });
  let copyCalls = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/api/boards/${targetId}/assets/copy`)) copyCalls++; });
  await clipboardText(page, text); await expect.poll(async () => (await contents(page)).length).toBe(6);
  const pasted = (await contents(page)).filter(element => element.id !== 'existing'), oldIds = new Set(copied.elements.map(element => element.id));
  expect(pasted.every(element => !oldIds.has(element.id))).toBe(true); expect(new Set(pasted.map(element => element.index)).size).toBe(5);
  const bounds = contentBounds(pasted); expect(bounds.x + bounds.w / 2).toBeCloseTo(700); expect(bounds.y + bounds.h / 2).toBeCloseTo(-250);
  const pastedShape = pasted.find(element => element.type === 'rect')!, pastedLine = pasted.find(element => element.type === 'connector')!, pastedStroke = pasted.find(element => element.type === 'stroke')!;
  if (pastedLine.type !== 'connector' || pastedStroke.type !== 'stroke') throw new Error('Expected mixed selection');
  expect(pastedLine.props.start).toMatchObject({ elementId: pastedShape.id }); expect(pastedLine.props.end).not.toHaveProperty('elementId');
  const dx = pastedShape.x - shape.x, dy = pastedShape.y - shape.y;
  expect(pastedLine.props.end).toEqual({ x: 300 + dx, y: 250 + dy });
  expect(resolveBinding(pastedLine.props.start, new Map(pasted.map(element => [element.id, element])))).toEqual(resolveBinding(bindToElement(pastedShape, 1, .5), new Map([[pastedShape.id, pastedShape]])));
  expect(pastedStroke.props.points).toEqual(stroke.props.points.map((value, index) => index % 3 === 0 ? value + dx : index % 3 === 1 ? value + dy : value));
  const imageIds = pasted.flatMap(element => element.type === 'image' ? [element.props.assetId] : []); expect(new Set(imageIds).size).toBe(1); expect(imageIds[0]).not.toBe(imported.props.assetId); expect(copyCalls).toBe(1);
  const stored = await page.request.get(`/api/boards/${targetId}/assets/${imageIds[0]}`); expect([...await stored.body()]).toEqual(pixels.bytes);
  expect((await page.request.get(`/api/boards/${targetId}/assets/${imported.props.assetId}`)).status()).toBe(404);
  await page.keyboard.press('Meta+z'); expect((await contents(page)).map(element => element.id)).toEqual(['existing']);
  await page.keyboard.press('Meta+Shift+z'); expect((await contents(page)).filter(element => element.id !== 'existing')).toEqual(pasted);
  const outsiderContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }), outsider = await outsiderContext.newPage();
  try {
    await signIn(outsider, 'outsider'); await newBoard(outsider, 'Unauthorized clipboard destination');
    expect((await outsider.request.get(`/api/boards/${sourceId}/assets/${imported.props.assetId}`)).status()).toBe(404);
    expect((await outsider.request.get(`/api/boards/${targetId}/assets/${imageIds[0]}`)).status()).toBe(404);
    await clipboardText(outsider, text); await expect(outsider.getByRole('alert')).toBeVisible(); expect(await contents(outsider)).toEqual([]);
  } finally { await outsiderContext.close(); }
});

test('invalid files, oversized bytes and actual GPU dimension limits fail before any upload', async ({ page }) => {
  await newBoard(page, 'Invalid image batch'); const valid = await image(page, 10, 10); let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/assets$/.test(request.url())) uploads++; });
  await drop(page, [valid, { bytes: [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')], type: 'image/svg+xml' }]);
  await expect(page.getByRole('alert')).toContainText('not a PNG, JPEG, or WebP'); expect(await contents(page)).toEqual([]); expect(uploads).toBe(0); await clearError(page);
  await page.evaluate(() => window.whiteboard.assets.importFiles([new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' })]));
  await expect(page.getByRole('alert')).toContainText('20 MiB'); expect(await contents(page)).toEqual([]); expect(uploads).toBe(0); await clearError(page);
  const limit = await page.evaluate(() => window.whiteboard.renderer.getMaxImageDimension());
  const tooWide = await image(page, limit + 1, 1); await drop(page, [tooWide]);
  await expect(page.getByRole('alert')).toContainText(`up to ${limit} pixels per side`); expect(await contents(page)).toEqual([]); expect(uploads).toBe(0);
});

test('failed uploads and closing during upload never insert partial batches', async ({ page }) => {
  await newBoard(page, 'Atomic upload failure'); const file = await image(page, 10, 10); let requests = 0;
  await page.route('**/api/boards/*/assets', async route => {
    requests++; if (requests === 1) await route.continue(); else await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Second upload failed' }) });
  });
  await drop(page, [file, file]); await expect(page.getByRole('alert')).toContainText('Second upload failed');
  expect(await contents(page)).toEqual([]); expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  await page.unroute('**/api/boards/*/assets'); await clearError(page);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/boards/*/assets', async route => { started(); await held; await route.continue(); });
  await drop(page, [file]); await pending; await page.evaluate(() => window.whiteboard.assets.destroy()); release();
  await expect.poll(() => page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0);
  await page.waitForLoadState('networkidle'); expect(await contents(page)).toEqual([]);
  await drop(page, [file]); expect(await contents(page)).toEqual([]);
});

test('cut requires successful clipboard writing and restores the whole selection in one undo', async ({ page }) => {
  await newBoard(page, 'Clipboard cut');
  await page.evaluate(() => { const { board, session } = window.whiteboard; board.create('rect', { id: 'cut-a' }); board.create('ellipse', { id: 'cut-b' }); board.undoManager.clear(); session.setState({ selectedIds: ['cut-a', 'cut-b'] }); });
  const original = await contents(page);
  await page.evaluate(async () => {
    const writeText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async () => { throw new Error('Clipboard permission denied'); };
    try { await window.whiteboard.assets.copySelection(true); } finally { navigator.clipboard.writeText = writeText; }
  });
  await expect(page.getByRole('alert')).toContainText('Clipboard permission denied'); expect(await contents(page)).toEqual(original);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(0); await clearError(page);
  await page.keyboard.press('Meta+x'); expect(await contents(page)).toEqual([]);
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).elements).toEqual(original);
  expect(await page.evaluate(() => window.whiteboard.board.undoManager.undoStack.length)).toBe(1);
  await page.keyboard.press('Meta+z'); expect(await contents(page)).toEqual(original);
});
