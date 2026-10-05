import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import type { GoogleConfig } from '../packages/server/src/google-config.js';

export const GOOGLE_TEST_EMAIL = 'browser.google@example.test';
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
interface Authorization { state: string; nonce: string; challenge: string; expires: number }
interface Code extends Authorization { allowed: boolean }
const opaque = () => randomBytes(32).toString('base64url');
const token = (claims: unknown) => [{ alg: 'RS256' }, claims, 'synthetic-test-signature'].map(part => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url')).join('.');

/** Disposable browser fixture only. The production server never imports this module. */
export async function startFakeGoogleProvider() {
  if (process.env.NODE_ENV !== 'test' || process.env.WHITEBOARD_TEST_GOOGLE !== '1') throw new Error('Fake Google requires explicit test fixture mode');
  const publicOrigin = 'http://127.0.0.1:5174', redirectUri = publicOrigin + '/api/auth/google/callback';
  const clientId = 'browser-google-client', clientSecret = opaque();
  const pending = new Map<string, Authorization>(), codes = new Map<string, Code>();
  async function body(request: IncomingMessage) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new Error('Invalid fixture request'); chunks.push(Buffer.from(chunk)); }
    return new URLSearchParams(Buffer.concat(chunks).toString());
  }
  const single = (params: URLSearchParams, name: string) => params.getAll(name).length === 1 ? params.get(name)! : '';
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      const now = Date.now();
      for (const collection of [pending, codes]) for (const [key, value] of collection) if (value.expires <= now) collection.delete(key);
      const url = new URL(request.url ?? '/', 'http://localhost');
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const params = url.searchParams, state = single(params, 'state'), nonce = single(params, 'nonce'), challenge = single(params, 'code_challenge');
        if (single(params, 'client_id') !== clientId || single(params, 'redirect_uri') !== redirectUri || single(params, 'response_type') !== 'code'
          || single(params, 'scope') !== 'openid email profile' || single(params, 'code_challenge_method') !== 'S256' || single(params, 'prompt') !== 'select_account'
          || ![state, nonce, challenge].every(value => /^[A-Za-z0-9_-]{43}$/.test(value)) || pending.size + codes.size >= 100) throw new Error('Invalid fixture request');
        const ticket = opaque(); pending.set(ticket, { state, nonce, challenge, expires: now + 180_000 });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; form-action 'self' ${publicOrigin}; base-uri 'none'; frame-ancestors 'none'` });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Test Google accounts</title><h1>Choose a test account</h1><form action="/approve" method="post"><input type="hidden" name="ticket" value="${ticket}"><button name="account" value="allowed">Continue with allowed account</button><button name="account" value="denied">Continue with denied account</button></form></html>`);
        return;
      }
      if (url.pathname === '/approve' && request.method === 'POST') {
        const params = await body(request), ticket = single(params, 'ticket'), account = single(params, 'account'), authorization = pending.get(ticket);
        if (!authorization || authorization.expires <= Date.now() || !['allowed', 'denied'].includes(account)) throw new Error('Invalid fixture request');
        pending.delete(ticket); const code = opaque(); codes.set(code, { ...authorization, allowed: account === 'allowed' });
        const callback = new URL(redirectUri); callback.search = new URLSearchParams({ state: authorization.state, code }).toString();
        response.writeHead(303, { Location: callback.href }); response.end(); return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const params = await body(request), code = single(params, 'code'), authorization = codes.get(code), verifier = single(params, 'code_verifier');
        if (!authorization || authorization.expires <= Date.now() || single(params, 'client_id') !== clientId || single(params, 'client_secret') !== clientSecret
          || single(params, 'redirect_uri') !== redirectUri || single(params, 'grant_type') !== 'authorization_code' || !/^[A-Za-z0-9_-]{43}$/.test(verifier)
          || createHash('sha256').update(verifier).digest('base64url') !== authorization.challenge) throw new Error('Invalid fixture request');
        codes.delete(code);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({
          id_token: token({ iss: 'https://accounts.google.com', aud: clientId, sub: authorization.allowed ? 'browser-google-subject' : 'browser-denied-subject',
            nonce: authorization.nonce, exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000 - 1, email_verified: true,
            email: authorization.allowed ? GOOGLE_TEST_EMAIL : 'outsider@denied.test', hd: authorization.allowed ? 'example.test' : 'denied.test',
            name: 'Google Board Member', picture: origin + '/avatar.png' }), access_token: 'synthetic-provider-access-token', token_type: 'Bearer',
        })); return;
      }
      if (url.pathname === '/avatar.png' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': picture.length }); response.end(picture); return; }
      response.writeHead(404); response.end('Fixture endpoint not found');
    } catch { if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'text/plain' }); response.end('Invalid fixture request'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config: GoogleConfig = { clientId, clientSecret, publicOrigin, redirectUri, allowedDomains: ['example.test'], allowedEmails: [], testIssuerOverride: origin };
  return { config, async close() { pending.clear(); codes.clear(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
