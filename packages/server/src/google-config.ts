import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizeExternalEmail } from './identity.js';

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly publicOrigin: string;
  readonly redirectUri: string;
  readonly allowedDomains: readonly string[];
  readonly allowedEmails: readonly string[];
  readonly testIssuerOverride?: string;
}

export interface GoogleEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Only present for a validated test provider; also bounds fake avatar URLs. */
  testIssuerOrigin?: string;
}

const invalid = (field: string): never => { throw new Error(`Invalid Google sign-in configuration (${field}).`); };
const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

function origin(value: string, testOnly = false): string {
  if (value.length > 2048 || value !== value.trim() || /[\\\x00-\x20\x7f]/.test(value)) return invalid(testOnly ? 'test provider' : 'public URL');
  let url: URL;
  try { url = new URL(value); } catch { return invalid(testOnly ? 'test provider' : 'public URL'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (testOnly ? url.protocol !== 'http:' || !loopback(url.hostname) : url.protocol !== 'https:' && (url.protocol !== 'http:' || !loopback(url.hostname)))) {
    return invalid(testOnly ? 'test provider' : 'public URL');
  }
  // Reject URL parser repairs such as shortened/octal IPv4 and missing slashes.
  const authority = /^https?:\/\/([^/]+)\/?$/i.exec(value)?.[1];
  const canonicalAuthority = url.host.toLowerCase(), defaultPort = url.protocol === 'https:' ? '443' : '80';
  if (!authority || ![canonicalAuthority, !url.port ? `${canonicalAuthority}:${defaultPort}` : canonicalAuthority].includes(authority.toLowerCase())) return invalid(testOnly ? 'test provider' : 'public URL');
  return url.origin;
}

function domain(value: string): string {
  const canonical = value.toLowerCase();
  if (canonical.length > 253 || !/^[a-z0-9.-]+$/.test(canonical)
    || canonical.split('.').some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return invalid('allowed domains');
  return canonical;
}

function list(value: string | undefined, normalize: (value: string) => string, field: string): readonly string[] {
  if (!value) return Object.freeze([]);
  if (value.length > 65536) return invalid(field);
  const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length > 1000) return invalid(field);
  try { return Object.freeze([...new Set(entries.map(normalize))]); } catch { return invalid(field); }
}

function secretFile(dataDirectory: string, value: string): string {
  let descriptor: number | undefined;
  try {
    if (value.length > 4096 || !value || /[\x00-\x1f\x7f]/.test(value)) return invalid('secret file');
    const lexicalDirectory = resolve(dataDirectory), directory = realpathSync(dataDirectory);
    const requested = isAbsolute(value) ? resolve(value) : resolve(lexicalDirectory, value);
    const inside = (leaf: string) => !!leaf && leaf !== '..' && !leaf.startsWith('..' + sep) && !isAbsolute(leaf);
    const lexicalLeaf = relative(lexicalDirectory, requested);
    const leaf = inside(lexicalLeaf) ? lexicalLeaf : relative(directory, requested), path = resolve(directory, leaf);
    if (!leaf || leaf === '..' || leaf.startsWith('..' + sep) || isAbsolute(leaf)) return invalid('secret file');
    let component = directory;
    for (const part of leaf.split(sep)) {
      component = resolve(component, part);
      if (lstatSync(component).isSymbolicLink()) return invalid('secret file');
    }
    if (!lstatSync(path).isFile()) return invalid('secret file');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 4096) return invalid('secret file');
    const bytes = Buffer.alloc(4097); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 4096) return invalid('secret file');
    const current = lstatSync(path);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || realpathSync(path) !== path) return invalid('secret file');
    return bytes.subarray(0, length).toString('utf8').trim();
  } catch { return invalid('secret file'); }
  finally { if (descriptor !== undefined) { try { closeSync(descriptor); } catch { invalid('secret file'); } } }
}

/** Incomplete deployments disable Google without reading optional secret files. */
export function readGoogleConfig(dataDirectory: string, env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = env.WHITEBOARD_GOOGLE_CLIENT_ID, inline = env.WHITEBOARD_GOOGLE_CLIENT_SECRET, file = env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE;
  const publicUrl = env.WHITEBOARD_PUBLIC_URL, rawDomains = env.WHITEBOARD_GOOGLE_ALLOWED_DOMAINS, rawEmails = env.WHITEBOARD_GOOGLE_ALLOWED_EMAILS;
  const hasAllowlist = [rawDomains, rawEmails].some(value => value?.split(',').some(entry => entry.trim()));
  if (!clientId?.trim() || !publicUrl?.trim() || !(inline?.trim() || file?.trim()) || !hasAllowlist) return null;
  if (inline !== undefined && file !== undefined) return invalid('conflicting secrets');
  if (clientId.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(clientId)) return invalid('client ID');
  const clientSecret = inline ?? secretFile(dataDirectory, file!);
  if (!clientSecret || clientSecret.length > 4096 || !/^[\x21-\x7e]+$/.test(clientSecret)) return invalid('client secret');
  const publicOrigin = origin(publicUrl);
  const allowedDomains = list(rawDomains, domain, 'allowed domains'), allowedEmails = list(rawEmails, normalizeExternalEmail, 'allowed emails');
  const testIssuerOverride = env.NODE_ENV === 'test' && env.WHITEBOARD_GOOGLE_ISSUER_OVERRIDE ? origin(env.WHITEBOARD_GOOGLE_ISSUER_OVERRIDE, true) : undefined;
  return Object.freeze({ clientId, clientSecret, publicOrigin, redirectUri: publicOrigin + '/api/auth/google/callback', allowedDomains, allowedEmails, ...(testIssuerOverride ? { testIssuerOverride } : {}) });
}

/** Recheck the test gate even when a caller supplies GoogleConfig via Options. */
export function googleEndpoints(config: GoogleConfig): GoogleEndpoints {
  if (process.env.NODE_ENV === 'test' && config.testIssuerOverride) {
    const testIssuerOrigin = origin(config.testIssuerOverride, true);
    return { authorizationEndpoint: testIssuerOrigin + '/authorize', tokenEndpoint: testIssuerOrigin + '/token', testIssuerOrigin };
  }
  return { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' };
}
