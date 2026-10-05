import { test, expect, type Page, type Locator } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceDirectory } from '../evidence';

// The fixture child enforces NODE_ENV=test; the client build keeps its normal environment.
const enabled = process.env.WHITEBOARD_TEST_GOOGLE === '1';
const googleEmail = 'browser.google@example.test', googleName = 'Google Board Member';
const pictureName = `${googleName}'s profile picture`;
async function connected(page: Page, mobile = false) {
  if (!mobile) await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await page.waitForFunction(() => !!window.whiteboard && !!window.whiteboardConnection?.provider.synced);
}
async function sharedBoard(owner: Page, title: string) {
  await owner.goto('/');
  await owner.getByLabel('Username', { exact: true }).fill('alice');
  await owner.getByLabel('Password', { exact: true }).fill('browser-test-only-password');
  await owner.getByRole('button', { name: 'Sign in', exact: true }).click();
  const back = owner.getByRole('button', { name: 'Back to boards', exact: true });
  await expect(back.or(owner.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
  if (await back.isVisible()) await back.click();
  await owner.getByRole('button', { name: 'New board', exact: true }).click();
  await owner.getByLabel('Board name', { exact: true }).fill(title);
  await owner.getByRole('button', { name: 'Create board', exact: true }).click();
  await connected(owner);
  const path = new URL(owner.url()).pathname;
  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  await owner.getByLabel('Username', { exact: true }).fill(googleEmail);
  await owner.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(owner.getByText(`Access granted to ${googleEmail}.`, { exact: true })).toBeVisible();
  await owner.getByRole('button', { name: 'Close dialog', exact: true }).click();
  return path;
}
async function googleSignIn(page: Page, path: string, denied = false) {
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  const link = page.getByRole('link', { name: 'Continue with Google', exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await page.getByRole('button', { name: denied ? 'Continue with denied account' : 'Continue with allowed account', exact: true }).click();
}
async function redAvatar(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth === 1 && img.naturalHeight === 1;
  })).toBe(true);
  const pixels = await image.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!; context.drawImage(element as HTMLImageElement, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  expect(pixels).toEqual([255, 0, 0, 255]);
  await expect(image).toHaveAttribute('src', /^\/api\/users\/[^/]+\/avatar\?v=\d+$/);
  return pixels;
}
const cursorLabel = (page: Page) => page.evaluate(name => {
  for (const peer of window.whiteboard.renderer.layers.presence.children) {
    const cursor = peer.children[0], label = cursor?.children[1];
    const glyph = label?.children[1] as { visible: boolean; text?: string; textRenderInfo?: { glyphBounds?: Float32Array } } | undefined;
    if (glyph?.text === name) return { text: glyph.text, visible: peer.visible && !!cursor?.visible && !!label?.visible && glyph.visible, ready: !!glyph.textRenderInfo?.glyphBounds?.length };
  }
  return { text: '', visible: false, ready: false };
}, googleName);

test.describe('Google sign-in disabled fixture', () => {
  test.skip(enabled, 'Run this default-disabled case without WHITEBOARD_TEST_GOOGLE.');
  test('default config hides Google while password sign-in remains available and auth route is 404', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const config = await page.request.get('/api/config'); expect(config.status()).toBe(200); expect(await config.json()).toEqual({ googleSignIn: false });
    await expect(page.getByRole('link', { name: 'Continue with Google', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Username', { exact: true })).toBeEditable(); await expect(page.getByLabel('Password', { exact: true })).toBeEditable();
    expect((await page.request.get('/api/auth/google/start?return=%2F')).status()).toBe(404);
    expect((await page.request.get('/api/session')).status()).toBe(401);
    writeFileSync(join(evidenceDirectory(info), 'disabled.json'), JSON.stringify({ config: await config.json(), startStatus: 404, sessionStatus: 401 }, null, 2));
  });
  test('unavailable public config keeps Google hidden and password login can create a connected board', async ({ page }, info) => {
    await page.route('**/api/config', route => route.fulfill({ status: 500, body: 'Unavailable' }));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Continue with Google', exact: true })).toHaveCount(0);
    await page.getByLabel('Username', { exact: true }).fill('alice');
    await page.getByLabel('Password', { exact: true }).fill('browser-test-only-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New board', exact: true }).click();
    await page.getByLabel('Board name', { exact: true }).fill('Config failure password board');
    await page.getByRole('button', { name: 'Create board', exact: true }).click();
    await connected(page);
    writeFileSync(join(evidenceDirectory(info), 'config-failure.json'), JSON.stringify({ configStatus: 500, googleLinkCount: 0, passwordLoginConnected: true, boardPath: new URL(page.url()).pathname }, null, 2));
  });
});

test.describe('Google sign-in enabled disposable provider', () => {
  test.skip(!enabled, 'Requires the opt-in Google fixture (WHITEBOARD_TEST_GOOGLE=1).');
  test('allowed Google navigation returns to the current shared board, shows real avatar and ready peer glyph, then reloads', async ({ page: owner, browser }, info) => {
    const path = await sharedBoard(owner, 'Google shared return');
    const context = await browser.newContext(), google = await context.newPage();
    try {
      await google.goto(path + '?before=click#old');
      const link = google.getByRole('link', { name: 'Continue with Google', exact: true }); await expect(link).toBeVisible();
      // No React rerender is needed: the actual link click must read the latest route.
      const returned = path + '?from=google&view=notes#return-kept';
      await google.evaluate(value => history.replaceState({}, '', value), returned);
      const start = google.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/google/start');
      await link.click(); expect(new URL((await start).url()).searchParams.get('return')).toBe(returned);
      await google.getByRole('button', { name: 'Continue with allowed account', exact: true }).click();
      await connected(google); expect(new URL(google.url()).pathname + new URL(google.url()).search + new URL(google.url()).hash).toBe(returned);
      const session = await google.evaluate(async () => (await fetch('/api/session')).json());
      expect(Object.keys(session).sort()).toEqual(['expiresAt', 'user']);
      expect(session.user).toEqual({ id: expect.any(String), username: googleEmail, name: googleName, avatarUrl: expect.stringMatching(/^\/api\/users\/[^/]+\/avatar\?v=\d+$/) });
      const cookie = (await context.cookies()).find(value => value.name === 'board_session'); expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Lax');
      expect(await google.evaluate(() => document.cookie)).not.toContain('board_session=');
      expect(await google.evaluate(() => {
        const token = window.whiteboardConnection!.provider.configuration.token;
        return typeof token === 'function' ? token() : token;
      })).toBe('');
      const pixels = await redAvatar(google.locator('.board-actions').getByRole('img', { name: pictureName, exact: true }));
      await google.mouse.move(640, 420);
      await expect(owner.getByLabel(googleName, { exact: true })).toBeVisible();
      await expect.poll(() => cursorLabel(owner)).toEqual({ text: googleName, visible: true, ready: true });
      const evidence = evidenceDirectory(info);
      writeFileSync(join(evidence, 'allowed.json'), JSON.stringify({ returned, session, avatarPixel: pixels, peerGlyph: await cursorLabel(owner), httpOnly: cookie!.httpOnly }, null, 2));
      await owner.screenshot({ path: join(evidence, 'peer-glyph.png') }); await google.screenshot({ path: join(evidence, 'board-avatar.png') });
      await google.reload(); await connected(google); expect(new URL(google.url()).pathname + new URL(google.url()).search + new URL(google.url()).hash).toBe(returned);
      await redAvatar(google.locator('.board-actions').getByRole('img', { name: pictureName, exact: true }));
      await google.getByRole('button', { name: 'Back to boards', exact: true }).click();
      await expect(google.locator('.account-user').getByText(googleName, { exact: true })).toBeVisible();
      await redAvatar(google.locator('.account-user').getByRole('img', { name: pictureName, exact: true }));
      await google.reload(); await expect(google.getByRole('button', { name: 'New board', exact: true })).toBeVisible();
      await expect(google.locator('.account-user').getByText(googleName, { exact: true })).toBeVisible();
      await redAvatar(google.locator('.account-user').getByRole('img', { name: pictureName, exact: true }));
      await google.screenshot({ path: join(evidence, 'account-avatar-reload.png') });
    } finally { await context.close(); }
  });

  test('denied external account gets a sanitized refusal and no session', async ({ page }, info) => {
    const callback = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/google/callback');
    await googleSignIn(page, '/', true);
    const response = await callback; expect(response.status()).toBe(403);
    await expect(page.getByRole('heading', { name: 'Unable to sign in', exact: true })).toBeVisible();
    await expect(page.getByText('This Google account is not allowed to sign in.', { exact: true })).toBeVisible();
    const body = await page.locator('body').innerText(); expect(body).not.toMatch(/outsider@denied\.test|client.secret|id_token|access_token|browserBindingHash/);
    expect((await page.request.get('/api/session')).status()).toBe(401);
    expect((await page.context().cookies()).some(cookie => cookie.name === 'board_session')).toBe(false);
    await page.getByRole('link', { name: 'Back to Whiteboard', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    writeFileSync(join(evidenceDirectory(info), 'denied.json'), JSON.stringify({ callbackStatus: response.status(), body, sessionStatus: 401 }, null, 2));
  });

  test('404 avatar uses an accessible fallback without breaking mobile account controls', async ({ page: owner, browser }, info) => {
    const path = await sharedBoard(owner, 'Google mobile fallback');
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } }), google = await context.newPage();
    try {
      let failedAvatars = 0;
      await google.route('**/api/users/*/avatar*', route => { failedAvatars++; return route.fulfill({ status: 404, body: 'Not found' }); });
      await googleSignIn(google, path); await connected(google, true);
      const fallback = google.locator('.board-actions').getByRole('img', { name: pictureName, exact: true });
      await expect(fallback).toBeVisible(); await expect.poll(() => fallback.evaluate(element => element.tagName)).toBe('SPAN');
      await expect(google.locator('.board-actions img')).toHaveCount(0); expect(failedAvatars).toBeGreaterThan(0);
      const bounds = await google.locator('.board-actions').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
      await expect(google.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await google.getByRole('button', { name: 'Back to boards', exact: true }).click();
      await expect(google.locator('.account-user').getByText(googleName, { exact: true })).toBeVisible();
      await expect(google.locator('.account-user').getByRole('img', { name: pictureName, exact: true })).toBeVisible();
      await expect(google.locator('.account-user img')).toHaveCount(0);
      const evidence = evidenceDirectory(info); await google.screenshot({ path: join(evidence, 'mobile-fallback.png') });
      writeFileSync(join(evidence, 'fallback.json'), JSON.stringify({ failedAvatars, bounds, width: 375, accessibleName: pictureName }, null, 2));
      await google.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(google.getByRole('link', { name: 'Continue with Google', exact: true })).toBeVisible();
      expect((await google.request.get('/api/session')).status()).toBe(401);
    } finally { await context.close(); }
  });
});
