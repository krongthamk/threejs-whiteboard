import { createHash } from 'node:crypto';
import { googleEndpoints, type GoogleConfig } from './google-config.js';
import { normalizeExternalEmail, displayName } from './identity.js';
import { readImageHeader } from '../../model/src/image-header.js';

export class GoogleAuthError extends Error {
  constructor(readonly denied = false) { super(denied ? 'This Google account is not allowed to sign in.' : 'Google sign-in could not be completed. Please try again.'); }
}

/** Return a local path even after the URL parser normalizes dot segments. */
export function safeGoogleReturnPath(value: string | null, publicOrigin: string): string {
  if (value === null) return '/';
  if (value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) throw new GoogleAuthError();
  try {
    const url = new URL(value, publicOrigin), decodedPath = decodeURIComponent(url.pathname);
    if (url.origin !== publicOrigin || url.pathname.startsWith('//') || decodedPath.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decodedPath)) throw new Error();
    return url.pathname + url.search + url.hash;
  } catch { throw new GoogleAuthError(); }
}

async function boundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (!response.ok || length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel(); throw new GoogleAuthError();
  }
  if (!response.body) throw new GoogleAuthError();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new GoogleAuthError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function decodePart(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new GoogleAuthError();
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new GoogleAuthError();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!record(value)) throw new GoogleAuthError();
  return value;
}

export interface GoogleIdentity { subject: string; email: string; displayName: string; picture?: string }

/**
 * Accept ID tokens only from the direct, fixed Google HTTPS token response.
 * OIDC Core 3.1.3.7 permits TLS server validation in place of signature validation
 * on this backchannel. Never expose a function accepting a browser ID token.
 * The loopback provider is independently gated by NODE_ENV in googleEndpoints.
 */
export async function exchangeGoogleCode(config: GoogleConfig, state: { nonce: string; verifier: string }, code: string): Promise<GoogleIdentity> {
  try {
    if (!code || code.length > 4096 || /[\x00-\x20\x7f]/.test(code)) throw new GoogleAuthError();
    const response = await fetch(googleEndpoints(config).tokenEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: state.verifier }),
    });
    const token: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedResponse(response, 64 * 1024)));
    if (!record(token) || typeof token.id_token !== 'string' || token.id_token.length > 16 * 1024) throw new GoogleAuthError();
    const parts = token.id_token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2]!) || Buffer.from(parts[2]!, 'base64url').toString('base64url') !== parts[2]) throw new GoogleAuthError();
    const header = decodePart(parts[0]!), claims = decodePart(parts[1]!);
    const now = Date.now() / 1000;
    if (header.alg !== 'RS256' || header.crit !== undefined
      || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss as string)
      || !(claims.aud === config.clientId || Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === config.clientId)
      || claims.azp !== undefined && claims.azp !== config.clientId
      || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now
      || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.iat >= claims.exp
      || claims.nonce !== state.nonce || claims.email_verified !== true
      || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || !/^[\x21-\x7e]+$/.test(claims.sub)) throw new GoogleAuthError();
    const email = normalizeExternalEmail(claims.email), emailDomain = email.split('@')[1]!;
    if (!config.allowedEmails.includes(email) && !(typeof claims.hd === 'string' && claims.hd.toLowerCase() === emailDomain && config.allowedDomains.includes(emailDomain))) throw new GoogleAuthError(true);
    return { subject: claims.sub, email, displayName: displayName(claims.name, email),
      ...(typeof claims.picture === 'string' && claims.picture.length <= 2048 ? { picture: claims.picture } : {}) };
  } catch (error) { throw error instanceof GoogleAuthError ? error : new GoogleAuthError(); }
}

/** Fingerprint only validated sources; no raw provider URL is persisted. */
function avatarSource(config: GoogleConfig, picture: string): { url: URL; fingerprint: string } {
  if (picture.length > 2048 || /[\\\x00-\x20\x7f]/.test(picture)) throw new GoogleAuthError();
  const url = new URL(picture), testOrigin = googleEndpoints(config).testIssuerOrigin;
  const googleHost = url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com');
  if (url.username || url.password || url.hash || !(testOrigin && url.origin === testOrigin || url.protocol === 'https:' && !url.port && googleHost)) throw new GoogleAuthError();
  return { url, fingerprint: createHash('sha256').update(url.href).digest('hex') };
}

export async function fetchGoogleAvatar(config: GoogleConfig, picture: string, previousFingerprint: string | null): Promise<{ bytes: Buffer; fingerprint: string } | null> {
  try {
    const { url, fingerprint } = avatarSource(config, picture);
    if (fingerprint === previousFingerprint) return null;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'image/png,image/jpeg' } });
    const bytes = await boundedResponse(response, 2 * 1024 * 1024), header = readImageHeader(bytes);
    if (!['image/png', 'image/jpeg'].includes(header.mimeType) || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== header.mimeType
      || header.width > 4096 || header.height > 4096 || header.width * header.height > 16_000_000) throw new GoogleAuthError();
    return { bytes, fingerprint };
  } catch { throw new GoogleAuthError(); }
}
