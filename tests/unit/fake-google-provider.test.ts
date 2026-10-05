import { afterEach, expect, test, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { startFakeGoogleProvider } from '../../scripts/fake-google-provider.js';

let fixture: Awaited<ReturnType<typeof startFakeGoogleProvider>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.unstubAllEnvs(); });

test.each([['production', '1'], ['test', ''], ['', '1']])('fake provider refuses nonexplicit mode %s/%s', async (environment, flag) => {
  vi.stubEnv('NODE_ENV', environment); vi.stubEnv('WHITEBOARD_TEST_GOOGLE', flag);
  await expect(startFakeGoogleProvider()).rejects.toThrow('explicit test fixture mode');
});

test('disposable provider verifies real PKCE, issues one-use codes and serves valid avatar bytes', async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('WHITEBOARD_TEST_GOOGLE', '1'); fixture = await startFakeGoogleProvider();
  const { config } = fixture, origin = config.testIssuerOverride!, opaque = () => randomBytes(32).toString('base64url');
  const verifier = opaque(), state = opaque(), nonce = opaque();
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile',
    prompt: 'select_account', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const authorization = await fetch(origin + '/authorize?' + params); expect(authorization.status).toBe(200);
  const html = await authorization.text(), ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/.exec(html)![1]!;
  const approval = await fetch(origin + '/approve', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ticket, account: 'allowed' }) });
  expect(approval.status).toBe(303); const redirect = new URL(approval.headers.get('location')!);
  expect(redirect.origin + redirect.pathname).toBe(config.redirectUri); expect(redirect.searchParams.get('state')).toBe(state);
  const exchange = (proof: string) => fetch(origin + '/token', { method: 'POST', body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
    redirect_uri: config.redirectUri, grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, code_verifier: proof }) });
  expect((await exchange(opaque())).status).toBe(400);
  const response = await exchange(verifier); expect(response.status).toBe(200);
  const body = await response.json() as { id_token: string }; const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1]!, 'base64url').toString());
  expect(claims).toMatchObject({ nonce, aud: config.clientId, email: 'browser.google@example.test', email_verified: true, name: 'Google Board Member' });
  expect((await exchange(verifier)).status).toBe(400);
  expect((await fetch(origin + '/approve', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ticket, account: 'allowed' }) })).status).toBe(400);
  const image = await fetch(claims.picture); expect(image.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await image.arrayBuffer()).toString('base64')).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==');
});
