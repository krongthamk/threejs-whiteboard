import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Explicit deployment smoke, not part of CI: creates one useful demonstration
// board on first invocation, then verifies that same board after redeployment.
const directory = 'docs/benchmarks/deployment';
const reportPath = join(directory, 'local.json');
const verifyExisting = process.argv.includes('--existing');
if (process.env.DEBUG || process.env.PWDEBUG) throw new Error('Unset DEBUG and PWDEBUG before running the private deployment check.');
let credentials: { url: string; username: string; password: string };
try {
  credentials = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/ThreejsWhiteboard/owner-credentials.json'), 'utf8'));
  if (credentials.url !== 'http://127.0.0.1:3001' || typeof credentials.username !== 'string' || typeof credentials.password !== 'string' || credentials.password.length < 12) throw new Error();
} catch { throw new Error('The private deployment credentials file is missing or invalid. Its contents have not been printed.'); }
const prior = verifyExisting ? JSON.parse(readFileSync(reportPath, 'utf8')) as { boardPath: string; svgSha256: string } : undefined;
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
try {
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message)); return page;
  };
  let page = await newPage();
  await page.goto(`${credentials.url}/?local=1`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'whiteboard' in window || 'whiteboardConnection' in window)).toBe(false);
  if (prior) await page.goto(`${credentials.url}${prior.boardPath}`);
  async function signIn() {
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await signIn();
  if (!prior) {
    const back = page.getByRole('button', { name: 'Back to boards', exact: true });
    await expect(back.or(page.getByRole('button', { name: 'New board', exact: true }))).toBeVisible();
    if (await back.isVisible()) await back.click();
    await page.getByRole('button', { name: 'New board', exact: true }).click();
    await page.getByLabel('Board name', { exact: true }).fill('Welcome to Whiteboard');
    await page.getByRole('button', { name: 'Create board', exact: true }).click();
  }
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  if (!prior) {
    for (const [tool, x, y, w, h] of [['Rectangle', 500, 350, 220, 140], ['Ellipse', 850, 350, 220, 140], ['Sticky note', 500, 570, 220, 170]] as const) {
      await page.getByRole('button', { name: tool, exact: true }).click();
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + w, y + h, { steps: 5 }); await page.mouse.up();
    }
    await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.mouse.click(500, 250);
    const editor = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await expect(editor).toBeFocused(); await page.keyboard.insertText('A shared place to think'); await editor.press('Meta+Enter');
  }
  const boardPath = new URL(page.url()).pathname;
  expect(boardPath).toMatch(/^\/board\//);
  expect(await page.evaluate(() => 'whiteboard' in window || 'whiteboardConnection' in window)).toBe(false);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom to fit', exact: true }).click();
  await page.screenshot({ path: join(directory, prior ? 'after-redeploy.png' : 'application.png') });
  async function exportSvg(): Promise<string> {
    await page.getByRole('button', { name: 'Export board', exact: true }).click();
    await page.getByRole('button', { name: 'SVG Scalable vector', exact: true }).click();
    await page.getByLabel('Include', { exact: true }).selectOption('board');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    const download = await pending, path = await download.path();
    return readFileSync(path!, 'utf8');
  }
  const svg = await exportSvg();
  expect(svg).toContain('A shared place to think');
  expect([...svg.matchAll(/data-element-id=/g)]).toHaveLength(4);
  const svgSha256 = createHash('sha256').update(svg).digest('hex');
  if (prior) expect(svgSha256).toBe(prior.svgSha256);
  await page.reload(); await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  expect(createHash('sha256').update(await exportSvg()).digest('hex')).toBe(svgSha256);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  // A fresh context has neither the document's IndexedDB nor the old session.
  await page.close(); page = await newPage();
  await page.goto(`${credentials.url}${boardPath}`); await signIn();
  await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  expect(createHash('sha256').update(await exportSvg()).digest('hex')).toBe(svgSha256);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  const report = { verifiedAt: new Date().toISOString(), url: credentials.url, boardPath, svgSha256, elements: 4, testHooksAbsent: true, anonymousLocalRouteAbsent: true, reloadMatches: true, freshContextMatches: true, mode: prior ? 'existing-board' : 'created-demo', pageErrors: errors };
  writeFileSync(prior ? join(directory, 'after-redeploy.json') : reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch {
  // Playwright action errors can include fill() arguments. Never propagate their
  // raw message, stack, cause or DEBUG logs from this credential-bearing flow.
  throw new Error('The private deployment UI check failed. No credential-bearing action details were printed; inspect the app and saved nonsecret screenshots.');
} finally { await browser.close(); }
