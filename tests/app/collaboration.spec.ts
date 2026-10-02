import { test, expect, type Page } from '@playwright/test';
import { evidenceDirectory, recordBrowserEvidence } from '../evidence';
import type { BoardConnection } from '../../packages/app/src/collaboration';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime; whiteboardConnection?: BoardConnection } }
const password = 'browser-test-only-password';
async function signIn(page: Page, username: string, path = '/') {
  await page.goto(path);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function boardList(page: Page) {
  const back = page.getByRole('button', { name: 'Back to boards', exact: true });
  await expect(back.or(page.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole('button', { name: 'New board', exact: true })).toBeVisible();
}
async function connected(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
}
async function draw(page: Page, name: string, x: number, y: number) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 140, y + 100, { steps: 5 }); await page.mouse.up();
}
const contents = (page: Page) => page.evaluate(() => window.whiteboard.board.readAll());

test('token-free sign-in and reload authenticate collaboration with the HttpOnly cookie', async ({ page }) => {
  const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session' && response.request().method() === 'POST');
  await signIn(page, 'alice');
  expect(await (await loginResponse).json()).not.toHaveProperty('token');
  expect(await page.evaluate(async () => (await fetch('/api/session')).json())).not.toHaveProperty('token');
  expect(await page.evaluate(() => document.cookie)).not.toContain('board_session=');
  await boardList(page);
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Cookie authentication');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await connected(page);
  expect(await page.evaluate(async () => {
    const token = window.whiteboardConnection!.provider.configuration.token;
    return typeof token === 'function' ? token() : token;
  })).toBe('');
  await page.reload(); await connected(page);
  expect(await page.evaluate(async () => (await fetch('/api/session')).json())).not.toHaveProperty('token');
});

test('an already revoked session can return to sign-in without reloading the page', async ({ page }) => {
  await signIn(page, 'alice');
  await boardList(page);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/session/logout', { method: 'POST' })).status)).toBe(204);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});

test('a revoked board session keeps sign-out reachable beside its recovery banner', async ({ page }) => {
  await signIn(page, 'alice');
  await boardList(page);
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Revoked board session');
  await page.getByRole('button', { name: 'Create board', exact: true }).click();
  await connected(page);
  expect(await page.evaluate(async () => (await fetch('/api/session/logout', { method: 'POST' })).status)).toBe(204);
  await page.evaluate(() => {
    window.whiteboardConnection!.provider.disconnect();
    window.whiteboardConnection!.provider.connect();
  });
  await expect(page.getByRole('alert')).toContainText(/Sign in/i);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('private boards converge, isolate undo, keep 30s offline edits and restore after reload', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [alice, bob, viewer] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = []; for (const page of [alice!, bob!, viewer!]) page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(alice!, 'alice');
    await boardList(alice!);
    await alice!.getByRole('button', { name: 'New board', exact: true }).click();
    await alice!.getByLabel('Board name', { exact: true }).fill('Shared thinking');
    await alice!.getByRole('button', { name: 'Create board', exact: true }).click();
    await connected(alice!);
    const path = new URL(alice!.url()).pathname;
    await alice!.getByRole('button', { name: 'Share', exact: true }).click();
    await alice!.getByLabel('Username', { exact: true }).fill('bob');
    await alice!.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(alice!.getByText('Access granted to bob.', { exact: true })).toBeVisible();
    await alice!.getByLabel('Username', { exact: true }).fill('viewer');
    await alice!.getByLabel('Permission').selectOption('viewer');
    await alice!.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(alice!.getByText('Access granted to viewer.', { exact: true })).toBeVisible();
    await alice!.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await signIn(bob!, 'bob', path); await connected(bob!);
    await draw(alice!, 'Rectangle', 500, 300);
    await expect.poll(async () => (await contents(bob!)).length).toBe(1);
    const original = (await contents(alice!))[0]!;
    await bob!.getByRole('button', { name: 'Select', exact: true }).click(); await bob!.mouse.click(550, 350);
    await bob!.getByRole('button', { name: 'Fill #dbe9ff', exact: true }).click();
    await expect.poll(async () => (await contents(alice!))[0]!.style.fill).toBe('#dbe9ff');
    await alice!.getByRole('button', { name: 'Select', exact: true }).click(); await alice!.mouse.click(550, 350);
    await alice!.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await contents(bob!))[0]!.x).toBe(original.x + 10);
    await alice!.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await contents(bob!))[0]!.x).toBe(original.x);
    expect((await contents(alice!))[0]!.style.fill).toBe('#dbe9ff');
    await expect(alice!.getByLabel('bob', { exact: true })).toBeVisible();
    await bob!.mouse.move(740, 460);
    await expect.poll(() => alice!.evaluate(() => window.whiteboard.renderer.stats().presencePeers)).toBe(1);
    await expect.poll(() => alice!.evaluate(() => window.whiteboard.renderer.stats().presenceLabels)).toBe(1);
    const offlineAt = Date.now();
    await contexts[0]!.setOffline(true);
    await alice!.evaluate(() => window.whiteboardConnection!.provider.disconnect());
    await expect(alice!.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    await alice!.keyboard.press('Shift+ArrowDown');
    await draw(bob!, 'Ellipse', 820, 500);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 30_050 - (Date.now() - offlineAt))));
    expect(Date.now() - offlineAt).toBeGreaterThanOrEqual(30_000);
    await contexts[0]!.setOffline(false); await alice!.evaluate(() => window.whiteboardConnection!.provider.connect());
    await connected(alice!);
    await expect.poll(() => contents(alice!)).toEqual(await contents(bob!));
    const converged = await contents(alice!);
    expect(converged).toHaveLength(2); expect(converged.find(element => element.id === original.id)!.y).toBe(original.y + 10);
    await alice!.reload(); await connected(alice!); expect(await contents(alice!)).toEqual(converged);
    await signIn(viewer!, 'viewer', path); await connected(viewer!);
    await expect(viewer!.getByText('View only', { exact: true })).toBeVisible();
    await expect(viewer!.getByRole('button', { name: 'Rectangle', exact: true })).toBeDisabled();
    await viewer!.getByRole('button', { name: 'Select', exact: true }).click(); await viewer!.mouse.click(550, 360); await viewer!.keyboard.press('Backspace');
    expect(await contents(viewer!)).toEqual(converged);
    await alice!.screenshot({ path: `${evidenceDirectory(testInfo)}/private-board.png` });
    recordBrowserEvidence(testInfo, 'docs/benchmarks/phase3');
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('board access remains private and board rename/list navigation persists', async ({ page, browser }) => {
  await signIn(page, 'alice');
  await boardList(page);
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Navigation test');
  await page.getByRole('button', { name: 'Create board', exact: true }).click(); await connected(page);
  await page.getByRole('button', { name: 'Rename board', exact: true }).click();
  await page.getByLabel('Board name', { exact: true }).fill('Planning room');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Planning room', exact: true })).toBeVisible();
  const path = new URL(page.url()).pathname;
  const context = await browser.newContext(), outsider = await context.newPage();
  try {
    await signIn(outsider, 'outsider', path);
    await expect(outsider.getByRole('alert')).toContainText('Board not found');
    await expect(outsider.getByRole('button', { name: 'Rectangle', exact: true })).toHaveCount(0);
    expect(await outsider.evaluate(() => !!window.whiteboard)).toBe(false);
  } finally { await context.close(); }
  await page.getByRole('button', { name: 'Back to boards', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Planning room', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('late board responses cannot replace a newer browser-history route', async ({ page }) => {
  const socketUrls: string[] = []; page.on('websocket', socket => socketUrls.push(socket.url()));
  await signIn(page, 'alice');
  await expect(page.getByRole('button', { name: 'Back to boards', exact: true }).or(page.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
  const boards = await page.evaluate(async () => {
    const create = async (title: string) => (await (await fetch('/api/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) })).json()).board;
    return [await create('Delayed board'), await create('Current board')];
  });
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/api/boards/${boards[0].id}`, async route => { started(); await held; await route.continue(); });
  const navigate = async (id: string) => page.evaluate(id => { history.pushState({}, '', `/board/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, id);
  await navigate(boards[0].id); await requested;
  await navigate(boards[1].id);
  await expect(page.getByRole('heading', { name: 'Current board', exact: true })).toBeVisible();
  await connected(page);
  expect(socketUrls.some(url => new URL(url).searchParams.get('boardId') === boards[1].id)).toBe(true);
  const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/boards/${boards[0].id}`);
  release(); await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'Current board', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/board/${boards[1].id}`);
  await expect(page.getByRole('heading', { name: 'Delayed board', exact: true })).toHaveCount(0);
});

test('live editor downgrade refreshes the local document and later regrant cannot replay rejected edits', async ({ browser }) => {
  test.setTimeout(45_000);
  const ownerContext = await browser.newContext(), editorContext = await browser.newContext();
  const owner = await ownerContext.newPage(), editor = await editorContext.newPage();
  try {
    await signIn(owner, 'alice');
    await expect(owner.getByRole('button', { name: 'Back to boards', exact: true }).or(owner.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
    const created = await owner.evaluate(async () => {
      const request = async (path: string, body: unknown) => { const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await response.text()); return response.status === 204 ? null : response.json(); };
      const { board } = await request('/api/boards', { title: 'Permission transitions' });
      await request(`/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }); return board;
    });
    await owner.goto(`/board/${created.id}`); await connected(owner);
    await signIn(editor, 'bob', `/board/${created.id}`); await connected(editor);
    await draw(owner, 'Rectangle', 500, 300);
    await expect.poll(async () => (await contents(editor)).length).toBe(1);
    const original = await contents(owner);
    // Preserve a genuine queued offline change while membership is downgraded.
    await editorContext.setOffline(true); await editor.evaluate(() => window.whiteboardConnection!.provider.disconnect());
    await draw(editor, 'Ellipse', 820, 500); expect(await contents(editor)).toHaveLength(2);
    const changeRole = async (role: string) => owner.evaluate(async ({ id, role }) => {
      const response = await fetch(`/api/boards/${id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', role }) });
      if (!response.ok) throw new Error(await response.text());
    }, { id: created.id, role });
    await changeRole('viewer');
    await editorContext.setOffline(false); await editor.evaluate(() => window.whiteboardConnection!.provider.connect());
    await expect(editor.getByText('View only', { exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Ellipse', exact: true })).toBeDisabled();
    await expect.poll(() => contents(editor)).toEqual(original);
    expect(await contents(owner)).toEqual(original);
    await changeRole('editor');
    await expect(editor.getByRole('button', { name: 'Ellipse', exact: true })).toBeEnabled();
    await connected(editor);
    expect(await contents(editor)).toEqual(original);
    await editor.reload(); await connected(editor); expect(await contents(editor)).toEqual(original);
    await draw(editor, 'Ellipse', 820, 500);
    await expect.poll(async () => (await contents(owner)).length).toBe(2);
    expect(await contents(editor)).toEqual(await contents(owner));
  } finally { await ownerContext.close(); await editorContext.close(); }
});

test('the Share dialog removes a member while protecting the owner and immediately closing their board', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [owner, member] = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await signIn(owner!, 'alice');
    const back = owner!.getByRole('button', { name: 'Back to boards', exact: true });
    if (await back.isVisible()) await back.click();
    await owner!.getByRole('button', { name: 'New board', exact: true }).click();
    await owner!.getByLabel('Board name', { exact: true }).fill('Revocable sharing');
    await owner!.getByRole('button', { name: 'Create board', exact: true }).click(); await connected(owner!);
    const path = new URL(owner!.url()).pathname;
    await owner!.getByRole('button', { name: 'Share', exact: true }).click();
    await owner!.getByLabel('Username', { exact: true }).fill('bob');
    await owner!.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(owner!.getByText('Access granted to bob.', { exact: true })).toBeVisible();
    await signIn(member!, 'bob', path); await connected(member!);
    await owner!.getByLabel('Username', { exact: true }).fill('alice');
    await owner!.getByRole('button', { name: 'Remove access', exact: true }).click();
    await expect(owner!.getByRole('alert')).toContainText('Owner membership cannot be removed');
    await owner!.getByLabel('Username', { exact: true }).fill('bob');
    await owner!.getByRole('button', { name: 'Remove access', exact: true }).click();
    await expect(owner!.getByText('Access removed for bob.', { exact: true })).toBeVisible();
    await expect(member!.getByRole('alert')).toContainText('Board not found');
    expect(await member!.evaluate(async () => (await fetch(location.pathname.replace('/board/', '/api/boards/'))).status)).toBe(404);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
