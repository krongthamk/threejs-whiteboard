import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { createWhiteboardServer } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-static-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'dist'); mkdirSync(join(root, 'fonts'), { recursive: true }); mkdirSync(join(root, 'assets'));
  const html = '<!doctype html><title>Whiteboard</title><div id="root"></div>';
  writeFileSync(join(root, 'index.html'), html); writeFileSync(join(root, 'fonts', 'Inter.woff'), Buffer.from('wOFF-font-fixture'));
  writeFileSync(join(root, 'assets', 'app-abcdefgh.js'), 'console.log("app")');
  writeFileSync(join(directory, 'outside.txt'), 'OUTSIDE-MUST-NOT-BE-SERVED');
  writeFileSync(join(root, '.env'), 'DOTFILE-MUST-NOT-BE-SERVED');
  symlinkSync(join(directory, 'outside.txt'), join(root, 'escape.txt'));
  const app = createWhiteboardServer({ databasePath: join(directory, 'database.sqlite'), assetDirectory: join(directory, 'uploads'), sessionSecret: 'static-fixture-private-session-secret-long-enough', staticDirectory: root, port: 0 });
  await app.listen(); cleanups.push(() => app.close());
  return { app, html, url: `http://127.0.0.1:${app.port}` };
}
test('production static serving supports board routes, fonts, cache validation, API and WebSocket paths', async () => {
  const { app, html, url } = await fixture();
  for (const path of ['/', '/board/1234-test-board']) { const response = await fetch(`${url}${path}`); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/html'); expect(response.headers.get('cache-control')).toBe('no-cache'); expect(await response.text()).toBe(html); }
  const font = await fetch(`${url}/fonts/Inter.woff`); expect(font.status).toBe(200); expect(font.headers.get('content-type')).toBe('font/woff'); expect(await font.text()).toBe('wOFF-font-fixture');
  const cached = await fetch(`${url}/fonts/Inter.woff`, { headers: { 'If-None-Match': font.headers.get('etag')! } }); expect(cached.status).toBe(304);
  const head = await fetch(`${url}/fonts/Inter.woff`, { method: 'HEAD' }); expect(head.headers.get('content-length')).toBe('17'); expect(await head.text()).toBe('');
  const bundle = await fetch(`${url}/assets/app-abcdefgh.js`); expect(bundle.headers.get('content-type')).toContain('text/javascript'); expect(bundle.headers.get('cache-control')).toContain('immutable');
  expect((await fetch(`${url}/api/session`)).status).toBe(401);
  expect((await fetch(`${url}/health`)).status).toBe(200); expect((await fetch(`${url}/ready`)).status).toBe(200);
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/collaboration`);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.close(); await new Promise<void>(resolve => socket.once('close', () => resolve()));
});
test('static lookup rejects traversal, dotfiles and symlinks outside its root without SPA masking', async () => {
  const { app, url } = await fixture();
  for (const path of ['/..%2foutside.txt', '/%2e%2e%2foutside.txt', '/fonts/%2e%2e/%2e%2e%2foutside.txt', '/%5c..%5coutside.txt', '/%00', '/.env', '/escape.txt', '/assets/missing.js', '/fonts/missing.woff']) {
    const response = await fetch(`${url}${path}`); expect(response.status, path).toBe(404); expect(await response.text()).not.toContain('MUST-NOT-BE-SERVED');
  }
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: app.port, path: '/%E0%A4%A' }, incoming => { let body = ''; incoming.on('data', chunk => { body += chunk; }); incoming.on('end', () => resolve({ status: incoming.statusCode!, body })); }); request.on('error', reject); request.end();
  });
  expect(response.status).toBe(404);
});
