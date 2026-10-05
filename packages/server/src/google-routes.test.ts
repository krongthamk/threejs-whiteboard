import { afterEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhiteboardServer } from './server.js';
import { createBackup, restoreBackup } from './operations.js';
import type { GoogleConfig } from './google-config.js';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';

const secret = 'google-route-tests-session-secret-at-least-32-characters';
const password = 'old-password-remains-private';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const jwt = (claims: Record<string, unknown>) => [{ alg: 'RS256' }, claims, 'test-provider-signature'].map(value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')).join('.');
async function setup(enabled = true) {
  vi.stubEnv('NODE_ENV', 'test');
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-google-routes-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const providerState = { patch: {} as Record<string, unknown>, tokenRequests: 0, avatarRequests: 0, avatarStatus: 200,
    tokenStatus: 200, beforeToken: undefined as undefined | (() => Promise<void>) };
  const provider = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/avatar')) {
        providerState.avatarRequests++; response.writeHead(providerState.avatarStatus, { 'Content-Type': 'image/png' }); response.end(png); return;
      }
      if (request.url !== '/token' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      providerState.tokenRequests++;
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString()), record = codes.get(body.get('code')!);
      if (!record || body.get('client_id') !== google.clientId || body.get('client_secret') !== google.clientSecret || body.get('redirect_uri') !== google.redirectUri
        || body.get('grant_type') !== 'authorization_code' || createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== record.challenge) {
        response.writeHead(400); response.end('provider private diagnostics'); return;
      }
      codes.delete(body.get('code')!); await providerState.beforeToken?.();
      response.writeHead(providerState.tokenStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'provider-access-secret', refresh_token: 'provider-refresh-secret', id_token: jwt({
        iss: 'https://accounts.google.com', aud: google.clientId, nonce: record.nonce, sub: 'google-subject-1', exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000 - 1, email: 'Member@Example.com', email_verified: true, hd: 'example.com', name: 'Google Display Name', picture: providerOrigin + '/avatar', ...providerState.patch,
      }) }));
    } catch { response.destroy(); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  cleanups.push(async () => { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
  const providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const google: GoogleConfig = { clientId: 'test-client', clientSecret: 'test-client-private-secret', publicOrigin: 'http://localhost:3001', redirectUri: 'http://localhost:3001/api/auth/google/callback', allowedDomains: ['example.com'], allowedEmails: [], testIssuerOverride: providerOrigin };
  const options = { databasePath: join(directory, 'whiteboard.sqlite'), assetDirectory: join(directory, 'assets'), sessionSecret: secret, port: 0, google: enabled ? google : null };
  const app = createWhiteboardServer(options); await app.listen(); cleanups.push(() => app.close());
  const origin = `http://127.0.0.1:${app.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(origin + path, { redirect: 'manual', ...init });
  async function start(returnPath = '/board/return-here?mode=edit#selection') {
    const response = await request('/api/auth/google/start?return=' + encodeURIComponent(returnPath));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!), state = location.searchParams.get('state')!, code = 'code-' + state;
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    codes.set(code, { nonce: location.searchParams.get('nonce')!, challenge: location.searchParams.get('code_challenge')! });
    return { response, location, state, code, cookie,
      callback: (init: RequestInit = {}) => request('/api/auth/google/callback?' + new URLSearchParams({ state, code }), { ...init, headers: { Cookie: cookie, ...init.headers } }) };
  }
  const counts = () => ({ users: app.store.db.prepare('SELECT count(*) AS n FROM users').get(), identities: app.store.db.prepare('SELECT count(*) AS n FROM identities').get(), sessions: app.store.db.prepare('SELECT count(*) AS n FROM sessions').get() });
  return { app, options, google, directory, providerOrigin, providerState, origin, request, start, counts };
}

test('disabled Google config is public and secret-free; auth routes remain unavailable', async () => {
  const { request, counts } = await setup(false), before = counts();
  expect(await (await request('/api/config')).json()).toEqual({ googleSignIn: false });
  for (const method of ['GET', 'HEAD', 'POST']) for (const route of ['start', 'callback']) expect((await request('/api/auth/google/' + route, { method })).status).toBe(404);
  expect(counts()).toEqual(before);
});

test('Google browser flow binds random state/PKCE, returns to the board, sets cookie-only session and serves avatar', async () => {
  const { request, start, app, google } = await setup();
  expect(await (await request('/api/config')).json()).toEqual({ googleSignIn: true });
  const flow = await start(), params = flow.location.searchParams;
  expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(params.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params.get('state')).not.toBe(params.get('nonce')); expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Object.fromEntries(params)).toMatchObject({ client_id: google.clientId, redirect_uri: google.redirectUri, response_type: 'code', scope: 'openid email profile', prompt: 'select_account', hd: 'example.com', code_challenge_method: 'S256' });
  expect(flow.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=600');
  const saved = app.store.db.prepare('SELECT * FROM oauth_states').get() as Record<string, string>;
  expect(saved.browser_binding_hash).toBe(createHash('sha256').update(flow.cookie.split('=')[1]!).digest('hex'));
  expect(saved.verifier).not.toBe(params.get('code_challenge'));
  const response = await flow.callback(); expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/board/return-here?mode=edit#selection');
  const cookies = response.headers.getSetCookie(), sessionCookie = cookies.find(cookie => cookie.startsWith('board_session='))!;
  expect(sessionCookie).toContain('HttpOnly; SameSite=Lax; Path=/; Max-Age=43200');
  expect(cookies.find(cookie => cookie.startsWith('board_google_state='))).toContain('Max-Age=0');
  expect(app.store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
  const profileResponse = await request('/api/session', { headers: { Cookie: sessionCookie.split(';')[0]! } });
  const session = await profileResponse.json() as { user: { id: string; username: string; name: string; avatarUrl: string }; expiresAt: number };
  expect(session.user).toEqual({ id: expect.any(String), username: 'member@example.com', name: 'Google Display Name', avatarUrl: expect.stringMatching(/^\/api\/users\/[^/]+\/avatar\?v=\d+$/) });
  expect(Object.keys(session).sort()).toEqual(['expiresAt', 'user']);
  expect(JSON.stringify(session)).not.toMatch(/token|secret|fingerprint|googleusercontent|127\.0\.0\.1/);
  expect((await request(session.user.avatarUrl)).status).toBe(401);
  for (const method of ['GET', 'HEAD']) {
    const avatar = await request(session.user.avatarUrl, { method, headers: { Cookie: sessionCookie.split(';')[0]! } });
    expect(avatar.status).toBe(200); expect(avatar.headers.get('content-type')).toBe('image/png');
    expect(avatar.headers.get('cache-control')).toBe('no-store'); expect(avatar.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await avatar.arrayBuffer()); expect(bytes.equals(method === 'HEAD' ? Buffer.alloc(0) : png)).toBe(true);
  }
});

test('missing/bad browser binding cannot burn state; valid callback succeeds once and replay fails', async () => {
  const { request, start, providerState, counts } = await setup(); const flow = await start();
  const path = '/api/auth/google/callback?' + new URLSearchParams({ code: flow.code, state: flow.state });
  const before = counts();
  expect((await request(path)).status).toBe(400);
  expect((await request(path, { headers: { Cookie: 'board_google_state=' + 'a'.repeat(43) } })).status).toBe(400);
  expect(providerState.tokenRequests).toBe(0); expect(counts()).toEqual(before);
  expect((await flow.callback()).status).toBe(302); const after = counts();
  expect((await flow.callback()).status).toBe(400); expect(providerState.tokenRequests).toBe(1); expect(counts()).toEqual(after);
});

test.each(['expired', 'missing-code', 'provider-error', 'wrong-state', 'duplicate-state', 'duplicate-code', 'token-error'])('callback rejects %s without account/session creation', async mode => {
  const { app, start, request, providerState, counts } = await setup(), flow = await start(), before = counts();
  const params = new URLSearchParams({ state: flow.state, code: flow.code });
  if (mode === 'expired') app.store.db.prepare('UPDATE oauth_states SET expires_at=?').run(Date.now() - 1);
  if (mode === 'missing-code') params.delete('code');
  if (mode === 'provider-error') params.set('error', '<script>provider-private-error</script>');
  if (mode === 'wrong-state') params.set('state', 'b'.repeat(43));
  if (mode === 'duplicate-state') params.append('state', flow.state);
  if (mode === 'duplicate-code') params.append('code', 'different');
  if (mode === 'token-error') providerState.tokenStatus = 500;
  const response = await request('/api/auth/google/callback?' + params, { headers: { Cookie: flow.cookie } });
  expect(response.status).toBe(400); expect(response.headers.get('content-type')).toContain('text/html');
  expect(await response.text()).not.toMatch(/script|private-error|private-secret|access-secret|refresh-secret/);
  expect(counts()).toEqual(before); expect(providerState.tokenRequests).toBe(mode === 'token-error' ? 1 : 0);
  if (!['wrong-state', 'duplicate-state'].includes(mode)) expect((await flow.callback()).status).toBe(400);
});

test.each([
  ['nonce', { nonce: 'bad' }], ['issuer', { iss: 'evil' }], ['audience', { aud: 'bad' }], ['expiry', { exp: 1 }],
  ['unverified email', { email_verified: false }], ['disallowed domain', { email: 'member@other.com', hd: 'other.com' }],
  ['domain without hd', { hd: undefined }], ['hd without matching email', { email: 'member@other.com' }],
] as const)('invalid %s never creates an account and consumes state', async (_label, patch) => {
  const { start, counts, providerState } = await setup(); providerState.patch = patch; const flow = await start(), before = counts();
  const response = await flow.callback(); expect([400, 403]).toContain(response.status); expect(counts()).toEqual(before);
  expect(providerState.avatarRequests).toBe(0); expect((await flow.callback()).status).toBe(400); expect(providerState.tokenRequests).toBe(1);
});

test('verified identity links the password account, retains its credentials and refreshes only changed avatar sources', async () => {
  const { app, start, providerState } = await setup(); const user = app.store.createUser('Member@Example.com', password);
  expect((await (await start()).callback()).status).toBe(302);
  expect(app.store.userByIdentity('google', 'google-subject-1')?.id).toBe(user.id); expect((await app.store.login(user.username, password))?.user.name).toBe('Google Display Name');
  const first = app.store.userProfile(user.id)!;
  expect((await (await start()).callback()).status).toBe(302); expect(providerState.avatarRequests).toBe(1);
  providerState.patch = { picture: 'http://127.0.0.1:1/unreachable' };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await (await start()).callback()).status).toBe(302); expect(app.store.userProfile(user.id)).toEqual(first);
  expect(warning).toHaveBeenCalledWith({ event: 'google-avatar-unavailable' });
});

test('avatar failure allows Google sign-in and NULL-hash accounts take the password failure path', async () => {
  const { start, providerState, request, app } = await setup(); providerState.avatarStatus = 500;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await (await start()).callback()).status).toBe(302);
  expect(app.store.userByName('member@example.com')?.avatarUrl).toBeNull();
  const response = await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'member@example.com', password }) });
  expect(response.status).toBe(401); expect(warning.mock.calls).toEqual([[{ event: 'google-avatar-unavailable' }]]);
});

test('avatar refresh follows URL changes, seven-day age and missing bytes while failed refresh retains the previous copy', async () => {
  const { start, providerState, app, options, providerOrigin } = await setup();
  const signIn = async () => { expect((await (await start()).callback()).status).toBe(302); return app.store.userProfile(app.store.userByName('member@example.com')!.id)!; };
  const first = await signIn(); expect(providerState.avatarRequests).toBe(1);
  providerState.patch = { picture: providerOrigin + '/avatar?v=2' };
  const changed = await signIn(); expect(providerState.avatarRequests).toBe(2); expect(changed.avatarKey).not.toBe(first.avatarKey); expect(changed.avatarUrl).not.toBe(first.avatarUrl);
  const oldTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
  app.store.db.prepare('UPDATE users SET avatar_updated_at=? WHERE id=?').run(oldTime, changed.id);
  const aged = app.store.userProfile(changed.id)!; providerState.avatarStatus = 500;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await signIn()).toEqual(aged); expect(providerState.avatarRequests).toBe(3);
  providerState.avatarStatus = 200; const refreshed = await signIn();
  expect(providerState.avatarRequests).toBe(4); expect(refreshed.avatarKey).not.toBe(aged.avatarKey); expect(refreshed.avatarUpdatedAt).toBeGreaterThan(oldTime);
  rmSync(join(options.assetDirectory, refreshed.avatarKey!)); const repaired = await signIn();
  expect(providerState.avatarRequests).toBe(5); expect(repaired.avatarKey).not.toBe(refreshed.avatarKey);
  expect(readFileSync(join(options.assetDirectory, repaired.avatarKey!)).equals(png)).toBe(true);
  expect(readFileSync(join(options.assetDirectory, first.avatarKey!)).equals(png)).toBe(true);
});

test('HEAD and unsafe return paths never create state; auth navigation keeps other Origin restrictions intact', async () => {
  const { app, request } = await setup();
  for (const route of ['start', 'callback']) expect((await request('/api/auth/google/' + route, { method: 'HEAD' })).status).toBe(404);
  for (const path of ['//evil.invalid', '/.//evil.invalid', '/%2fevil.invalid']) expect((await request('/api/auth/google/start?return=' + encodeURIComponent(path))).status).toBe(400);
  expect(app.store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
  expect((await request('/api/auth/google/start', { headers: { Origin: 'https://accounts.google.com' } })).status).toBe(302);
  expect((await request('/api/session', { headers: { Origin: 'https://accounts.google.com' } })).status).toBe(403);
});

test('password, OAuth start and callback share the per-address throttle', async () => {
  const { request, start, providerState } = await setup(); const flow = await start();
  for (let index = 0; index < 29; index++) expect((await request('/api/auth/google/callback?state=wrong')).status).toBe(400);
  expect((await flow.callback()).status).toBe(429); expect((await request('/api/auth/google/start')).status).toBe(429);
  expect((await request('/api/session', { method: 'POST' })).status).toBe(429); expect(providerState.tokenRequests).toBe(0);
});

test('draining during token exchange does not create identities or sessions', async () => {
  const { app, start, providerState, counts, request } = await setup(); const flow = await start(), before = counts();
  providerState.beforeToken = async () => { app.beginDrain(); };
  expect((await flow.callback()).status).toBe(503); expect(counts()).toEqual(before);
  expect((await request('/api/auth/google/start')).status).toBe(503);
});

test('a connected account publishes its refreshed Google name while cached client names and anti-spoofing still work', async () => {
  const { app, start } = await setup(); const user = app.store.createUser('Member@Example.com', password);
  const session = (await app.store.login(user.username, password))!, board = app.store.createBoard(user.id, 'Profile refresh');
  const doc = new Y.Doc(), socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${app.port}/collaboration`, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: board.id, token: session.token, document: doc }); provider.attach();
  cleanups.push(() => { provider.destroy(); socket.destroy(); doc.destroy(); });
  const until = async (check: () => boolean) => { const started = Date.now(); while (!check()) { if (Date.now() - started > 1500) throw new Error('Live profile awareness timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  await until(() => provider.isSynced);
  const document = app.server.hocuspocus.documents.get(board.id)!, connection = document.getConnections()[0]!;
  const presence = () => document.awareness.getStates().get(doc.clientID);
  provider.awareness!.setLocalState({ userId: user.id, name: session.user.name, cursor: { x: 1, y: 1 } });
  await until(() => presence()?.cursor?.x === 1);
  expect((await (await start()).callback()).status).toBe(302);
  provider.awareness!.setLocalState({ userId: user.id, name: 'Google Display Name', cursor: { x: 2, y: 2 } });
  await until(() => presence()?.cursor?.x === 2); expect(presence()?.name).toBe('Google Display Name');
  provider.awareness!.setLocalState({ userId: user.id, name: session.user.name, cursor: { x: 3, y: 3 } });
  await until(() => presence()?.cursor?.x === 3); expect(presence()?.name).toBe('Google Display Name');
  const before = app.network.awarenessMessages;
  provider.awareness!.setLocalState({ userId: user.id, name: 'Another Account', cursor: { x: 4, y: 4 } });
  await until(() => app.network.awarenessMessages > before); expect(presence()?.cursor?.x).toBe(3);
  expect(document.getConnections()[0]).toBe(connection); expect(connection.context.invalidated).not.toBe(true);
});

test('restored identity/session/avatar remain usable through the authenticated HTTP route', async () => {
  const { app, start, directory, options } = await setup(); const response = await (await start()).callback();
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('board_session='))!.split(';')[0]!;
  const original = app.store.userByName('member@example.com')!;
  const backup = join(directory, 'backup'), restoredDirectory = join(directory, 'restored');
  await createBackup(app.store, options.assetDirectory, secret, backup); restoreBackup(backup, restoredDirectory);
  const restored = createWhiteboardServer({ databasePath: join(restoredDirectory, 'whiteboard.sqlite'), assetDirectory: join(restoredDirectory, 'assets'), sessionSecret: readFileSync(join(restoredDirectory, 'session-secret'), 'utf8'), port: 0 });
  await restored.listen(); cleanups.push(() => restored.close());
  const origin = `http://127.0.0.1:${restored.port}`;
  expect(restored.store.userByIdentity('google', 'google-subject-1')?.id).toBe(original.id);
  expect(await (await fetch(origin + '/api/session', { headers: { Cookie: cookie } })).json()).toMatchObject({ user: original });
  const avatar = await fetch(origin + original.avatarUrl, { headers: { Cookie: cookie } });
  expect(avatar.status).toBe(200); expect(Buffer.from(await avatar.arrayBuffer()).equals(png)).toBe(true);
});
