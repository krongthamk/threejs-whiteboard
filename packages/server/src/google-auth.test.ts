import { afterEach, expect, test, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { exchangeGoogleCode, fetchGoogleAvatar, safeGoogleReturnPath } from './google-auth.js';
import type { GoogleConfig } from './google-config.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const state = { nonce: 'n'.repeat(43), verifier: 'v'.repeat(43) };
const base: GoogleConfig = { clientId: 'test-client', clientSecret: 'private-client-secret', publicOrigin: 'http://localhost:3001', redirectUri: 'http://localhost:3001/api/auth/google/callback', allowedDomains: ['example.com'], allowedEmails: [] };
const claims = () => ({ iss: 'https://accounts.google.com', aud: base.clientId, exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000 - 1,
  nonce: state.nonce, sub: 'stable-google-subject', email: 'Member@Example.com', email_verified: true, hd: 'example.com', name: 'Member Name' });
const jwt = (value: unknown, header: unknown = { alg: 'RS256' }) => [header, value, 'fake-test-signature'].map(part => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url')).join('.');
async function provider(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  vi.stubEnv('NODE_ENV', 'test');
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => response.destroy()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { config: { ...base, testIssuerOverride: origin }, origin };
}

test('local return paths preserve board queries and fragments after safe normalization', () => {
  expect(safeGoogleReturnPath(null, base.publicOrigin)).toBe('/');
  expect(safeGoogleReturnPath('/board/a?mode=edit#hello', base.publicOrigin)).toBe('/board/a?mode=edit#hello');
  expect(safeGoogleReturnPath('/board/../board/a', base.publicOrigin)).toBe('/board/a');
  expect(safeGoogleReturnPath('/board/%E0%B9%84%E0%B8%97%E0%B8%A2', base.publicOrigin)).toBe('/board/%E0%B9%84%E0%B8%97%E0%B8%A2');
});
test.each(['', '//evil.invalid', 'https://evil.invalid', '\\evil.invalid', '/\\evil.invalid', '/.//evil.invalid', '/a/..//evil.invalid', '/%2fexample.com', '/%5cevil', '/%00bad', '/bad\npath', '/bad%ZZ', '/' + 'a'.repeat(2048)])('refuses unsafe return path %s', path => {
  expect(() => safeGoogleReturnPath(path, base.publicOrigin)).toThrow('Google sign-in could not be completed');
});

test('exchange sends the code and PKCE only in the server POST and returns the bounded public identity', async () => {
  let requestData: URLSearchParams | undefined;
  const { config } = await provider(async (request, response) => {
    expect(request.url).toBe('/token'); expect(request.method).toBe('POST');
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
    requestData = new URLSearchParams(Buffer.concat(chunks).toString());
    response.end(JSON.stringify({ id_token: jwt(claims()), access_token: 'never-return-me', refresh_token: 'never-save-me' }));
  });
  expect(await exchangeGoogleCode(config, state, 'one-use-code')).toEqual({ subject: 'stable-google-subject', email: 'member@example.com', displayName: 'Member Name' });
  expect(Object.fromEntries(requestData!)).toEqual({ code: 'one-use-code', client_id: base.clientId, client_secret: base.clientSecret,
    redirect_uri: base.redirectUri, grant_type: 'authorization_code', code_verifier: state.verifier });
});

test.each([
  ['issuer', { iss: 'https://evil.invalid' }], ['audience', { aud: 'another-client' }], ['extra audience', { aud: [base.clientId, 'another-client'] }],
  ['authorized party', { azp: 'another-client' }], ['expired', { exp: 1 }], ['string expiry', { exp: '999999999999' }],
  ['future issue', { iat: Date.now() / 1000 + 600 }], ['missing issue', { iat: undefined }], ['nonce', { nonce: 'wrong' }],
  ['unverified', { email_verified: false }], ['string verified', { email_verified: 'true' }], ['missing subject', { sub: '' }],
  ['object subject', { sub: {} }], ['invalid email', { email: 'space @example.com' }], ['missing hosted domain', { hd: undefined }],
  ['hosted domain differs from email', { hd: 'other.com' }], ['email domain differs from hosted domain', { email: 'member@other.com' }],
  ['invalid display name', { name: '\ud800' }],
] as const)('exchange rejects %s without including private provider material', async (_label, patch) => {
  const { config } = await provider((_request, response) => { response.end(JSON.stringify({ id_token: jwt({ ...claims(), ...patch }) })); });
  await expect(exchangeGoogleCode(config, state, 'one-use-code')).rejects.toThrow(/^This Google account is not allowed|^Google sign-in could not be completed/);
});

test('explicit email allowlist is an alternative to hosted-domain membership; empty allowlists deny', async () => {
  const { config } = await provider((_request, response) => { response.end(JSON.stringify({ id_token: jwt({ ...claims(), hd: undefined }) })); });
  expect(await exchangeGoogleCode({ ...config, allowedDomains: [], allowedEmails: ['member@example.com'] }, state, 'code')).toMatchObject({ email: 'member@example.com' });
  await expect(exchangeGoogleCode({ ...config, allowedDomains: [], allowedEmails: [] }, state, 'code')).rejects.toThrow('not allowed');
});

test.each([
  'not-json', JSON.stringify({ id_token: 'malformed' }), JSON.stringify({ id_token: jwt(claims(), { alg: 'none' }) }),
  JSON.stringify({ id_token: jwt(claims(), { alg: 'RS256', crit: ['anything'] }) }), JSON.stringify({ id_token: jwt([]) }),
  JSON.stringify({ id_token: 'a'.repeat(16 * 1024 + 1) }), JSON.stringify({ id_token: jwt(claims()), padding: 'x'.repeat(64 * 1024) }),
])('exchange bounds and validates the token response %#', async body => {
  const { config } = await provider((_request, response) => { response.write(body.slice(0, 10)); response.end(body.slice(10)); });
  await expect(exchangeGoogleCode(config, state, 'code')).rejects.toThrow('Google sign-in could not be completed');
});

test('token redirects and error responses are not followed or exposed', async () => {
  let redirected = 0;
  const { config } = await provider((request, response) => {
    if (request.url === '/token') { response.writeHead(302, { Location: '/private-secret' }); response.end('private-client-secret'); }
    else { redirected++; response.end(JSON.stringify({ id_token: jwt(claims()) })); }
  });
  await expect(exchangeGoogleCode(config, state, 'code')).rejects.toThrow('Google sign-in could not be completed');
  expect(redirected).toBe(0);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
test('avatar bytes are bounded, locally fingerprinted and unchanged sources skip fetching', async () => {
  let requests = 0;
  const { config, origin } = await provider((_request, response) => { requests++; response.setHeader('Content-Type', 'image/png'); response.end(png); });
  const avatar = await fetchGoogleAvatar(config, origin + '/picture', null);
  expect(avatar!.bytes.equals(png)).toBe(true); expect(avatar!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(await fetchGoogleAvatar(config, origin + '/picture', avatar!.fingerprint)).toBeNull(); expect(requests).toBe(1);
});

test.each(['http://lh3.googleusercontent.com/avatar', 'https://googleusercontent.com.evil.invalid/a', 'https://evilgoogleusercontent.com/a',
  'https://user:password@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com:8443/a', 'https://lh3.googleusercontent.com/a#fragment',
  'http://127.0.0.1:1/private', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'https://lh3.googleusercontent.com/\\a'])('avatar refuses unsafe source before fetching: %s', async source => {
  const spy = vi.spyOn(globalThis, 'fetch');
  await expect(fetchGoogleAvatar(base, source, null)).rejects.toThrow('Google sign-in could not be completed');
  expect(spy).not.toHaveBeenCalled();
});

test.each(['mime', 'dimensions', 'size', 'redirect', 'status'])('avatar rejects %s violations', async mode => {
  const { config, origin } = await provider((_request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { Location: '/other' }); response.end(); return; }
    if (mode === 'status') { response.writeHead(500); response.end('secret'); return; }
    response.setHeader('Content-Type', mode === 'mime' ? 'image/jpeg' : 'image/png');
    const bytes = Buffer.from(png); if (mode === 'dimensions') bytes.writeUInt32BE(4097, 16);
    if (mode === 'size') { response.write(bytes); response.end(Buffer.alloc(2 * 1024 * 1024)); } else response.end(bytes);
  });
  await expect(fetchGoogleAvatar(config, origin + '/avatar', null)).rejects.toThrow('Google sign-in could not be completed');
});

test('production helper calls ignore an explicit provider override for tokens and avatars', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const config = { ...base, testIssuerOverride: 'http://127.0.0.1:43123' };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id_token: jwt(claims()) })));
  expect(await exchangeGoogleCode(config, state, 'code')).toMatchObject({ subject: 'stable-google-subject' });
  expect(fetch.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  await expect(fetchGoogleAvatar(config, config.testIssuerOverride + '/avatar', null)).rejects.toThrow('Google sign-in could not be completed');
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
  expect((await fetchGoogleAvatar(config, 'https://lh3.googleusercontent.com/avatar', null))!.bytes).toEqual(png);
  expect(fetch.mock.calls[1]![0].toString()).toBe('https://lh3.googleusercontent.com/avatar');
  expect(fetch.mock.calls[1]![1]).toMatchObject({ redirect: 'error' });
});

test.each(['token', 'avatar'] as const)('%s rejects oversized or malformed advertised content lengths before reading', async kind => {
  const cap = kind === 'token' ? 64 * 1024 : 2 * 1024 * 1024;
  for (const length of [String(cap + 1), '-1', 'not-a-size']) {
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { 'Content-Length': length, 'Content-Type': 'image/png' } });
    const reader = vi.spyOn(response.body!, 'getReader');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    const operation = kind === 'token' ? exchangeGoogleCode(base, state, 'code') : fetchGoogleAvatar(base, 'https://lh3.googleusercontent.com/avatar', null);
    await expect(operation).rejects.toThrow('Google sign-in could not be completed');
    expect(reader).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  }
});

test.each(['token', 'avatar'] as const)('%s bounds a stalled response body with its request abort signal', async kind => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds); return controller.signal;
  });
  let requestSignal: AbortSignal | null | undefined, body: ReadableStream<Uint8Array> | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    requestSignal = options?.signal;
    body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([123]));
      requestSignal!.addEventListener('abort', () => controller.error(requestSignal!.reason), { once: true });
    } });
    return new Response(body, { headers: { 'Content-Type': 'image/png' } });
  });
  const promise = kind === 'token' ? exchangeGoogleCode(base, state, 'code') : fetchGoogleAvatar(base, 'https://lh3.googleusercontent.com/avatar', null);
  const rejected = expect(promise).rejects.toThrow('Google sign-in could not be completed');
  const milliseconds = kind === 'token' ? 10_000 : 5000;
  await vi.advanceTimersByTimeAsync(milliseconds - 1); expect(requestSignal!.aborted).toBe(false); expect(body!.locked).toBe(true);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(timeout).toHaveBeenCalledWith(milliseconds); expect(requestSignal!.aborted).toBe(true); expect(body!.locked).toBe(false);
});

// Fixed 2x2 red JPEG encoded independently of the header parser used by the helper.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z', 'base64');
test('a genuine JPEG avatar preserves exact bytes and accepts its matching MIME', async () => {
  const { config, origin } = await provider((_request, response) => { response.setHeader('Content-Type', 'image/jpeg'); response.end(jpeg); });
  const avatar = await fetchGoogleAvatar(config, origin + '/avatar.jpg', null);
  expect(avatar!.bytes).toEqual(jpeg); expect(avatar!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
});
