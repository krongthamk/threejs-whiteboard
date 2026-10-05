import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { googleEndpoints, readGoogleConfig } from './google-config.js';
import { serverConfig } from './config.js';

let directory: string;
const valid = (): NodeJS.ProcessEnv => ({
  WHITEBOARD_GOOGLE_ENABLED: '1',
  WHITEBOARD_GOOGLE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com',
  WHITEBOARD_GOOGLE_CLIENT_SECRET: 'fixture-secret-do-not-echo',
  WHITEBOARD_PUBLIC_URL: 'https://board.example',
  WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: 'Example.COM',
});
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'whiteboard-google-config-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('Google sign-in configuration', () => {
  it.each([undefined, '', '0', 'false', 'true'])('keeps configured Google disabled unless explicitly enabled: %s', enabled => {
    expect(readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ENABLED: enabled })).toBeNull();
    const env = valid(); delete env.WHITEBOARD_GOOGLE_CLIENT_SECRET;
    expect(readGoogleConfig(directory, { ...env, WHITEBOARD_GOOGLE_ENABLED: enabled,
      WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE: '/missing/private/file' })).toBeNull();
  });

  it('disables absent and partial configurations without reading a secret file', () => {
    expect(readGoogleConfig(directory, {})).toBeNull();
    for (const key of ['WHITEBOARD_GOOGLE_CLIENT_ID', 'WHITEBOARD_GOOGLE_CLIENT_SECRET', 'WHITEBOARD_PUBLIC_URL', 'WHITEBOARD_GOOGLE_ALLOWED_DOMAINS']) {
      const env = valid(); delete env[key]; expect(readGoogleConfig(directory, env)).toBeNull();
    }
    expect(readGoogleConfig(directory, { WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE: '/missing/private/file' })).toBeNull();
    expect(readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: ' , ', WHITEBOARD_GOOGLE_ALLOWED_EMAILS: '' })).toBeNull();
  });

  it('canonicalizes and deduplicates bounded domains and full external emails', () => {
    const config = readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: 'EXAMPLE.com, example.com, team.example.com', WHITEBOARD_GOOGLE_ALLOWED_EMAILS: 'Alice+Team@EXAMPLE.com, alice+team@example.com' })!;
    expect(config).toMatchObject({ publicOrigin: 'https://board.example', redirectUri: 'https://board.example/api/auth/google/callback', allowedDomains: ['example.com', 'team.example.com'], allowedEmails: ['alice+team@example.com'] });
    expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config.allowedDomains)).toBe(true);
    expect(readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: '', WHITEBOARD_GOOGLE_ALLOWED_EMAILS: 'a'.repeat(64) + '@example.com' })!.allowedEmails).toHaveLength(1);
  });

  it('accepts exact DNS/email bounds and punycode without rewriting mailbox aliases', () => {
    const longestDomain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
    expect(longestDomain).toHaveLength(253);
    expect(readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: longestDomain + ',xn--bcher-kva.example' })!.allowedDomains).toEqual([longestDomain, 'xn--bcher-kva.example']);
    const longestEmail = 'a'.repeat(64) + '@' + ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
    expect(longestEmail).toHaveLength(254);
    expect(readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_EMAILS: longestEmail + ',a.b+tag@example.com' })!.allowedEmails).toEqual([longestEmail, 'a.b+tag@example.com']);
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: longestDomain + 'x' })).toThrow('allowed domains');
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_EMAILS: longestEmail + 'x' })).toThrow('allowed emails');
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: Array.from({ length: 1001 }, (_, i) => `team${i}.example`).join(',') })).toThrow('allowed domains');
  });

  it.each(['https://board.example', 'https://board.example/', 'https://board.example:443', 'HTTPS://BOARD.EXAMPLE', 'http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001'])('accepts public origin %s', value => {
    expect(readGoogleConfig(directory, { ...valid(), WHITEBOARD_PUBLIC_URL: value })!.publicOrigin).toBe(new URL(value).origin);
  });

  it.each(['http://board.example', 'http://localhost.evil', 'http://127.1', 'http://0177.0.0.1', 'https:board.example', 'https://name:password@board.example', 'https://board.example/path', 'https://board.example?x=1', 'https://board.example#x', 'https://board.example\\path', 'https://board.example\n'])('rejects malformed or nonlocal HTTP public URL without leaking it: %s', value => {
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_PUBLIC_URL: value })).toThrow('Invalid Google sign-in configuration (public URL).');
  });

  it.each(['-example.com', 'example-.com', 'example..com', 'a'.repeat(64) + '.com', '例.com', 'example.com/', 'https://example.com', 'example.com\nother.com'])('rejects invalid domain %s', value => {
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: value })).toThrow('Invalid Google sign-in configuration (allowed domains).');
  });

  it.each(['a..b@example.com', 'a@-example.com', 'a'.repeat(65) + '@example.com', '例@example.com', 'a@example.com\u0000'])('uses the shared email validator and sanitizes errors: %s', value => {
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_EMAILS: value })).toThrow('Invalid Google sign-in configuration (allowed emails).');
  });

  it('fails fully configured conflicting or malformed credentials without exposing values', () => {
    const marker = 'do-not-echo-this-secret';
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_CLIENT_SECRET: marker, WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE: '/private-secret' })).toThrow('Invalid Google sign-in configuration (conflicting secrets).');
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_CLIENT_SECRET: marker + '\nextra' })).toThrow('Invalid Google sign-in configuration (client secret).');
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_CLIENT_ID: 'client secret@example.com' })).toThrow('Invalid Google sign-in configuration (client ID).');
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_CLIENT_SECRET: 'x'.repeat(4097) })).toThrow('client secret');
    expect(() => readGoogleConfig(directory, { ...valid(), WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: 'x'.repeat(65537) })).toThrow('allowed domains');
  });

  it('reads a bounded 0600 regular secret file within the data directory', () => {
    mkdirSync(join(directory, 'private')); const file = join(directory, 'private', 'google-secret'); writeFileSync(file, 'file-only-fixture-secret\n', { mode: 0o600 });
    const env = valid(); delete env.WHITEBOARD_GOOGLE_CLIENT_SECRET; env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = file;
    expect(readGoogleConfig(directory, env)!.clientSecret).toBe('file-only-fixture-secret');
    env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = 'private/google-secret'; expect(readGoogleConfig(directory, env)!.clientSecret).toBe('file-only-fixture-secret');
  });

  it('rejects permissions, oversized/empty files, directories, missing files and symlink escape', () => {
    const env = valid(); delete env.WHITEBOARD_GOOGLE_CLIENT_SECRET;
    const file = join(directory, 'secret'); env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = file;
    writeFileSync(file, 'fixture', { mode: 0o644 }); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
    chmodSync(file, 0o600); writeFileSync(file, 'x'.repeat(4097)); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
    writeFileSync(file, ''); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
    env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = directory; expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
    env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = join(directory, 'missing'); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
    const outside = mkdtempSync(join(tmpdir(), 'whiteboard-outside-'));
    try {
      writeFileSync(join(outside, 'secret'), 'outside', { mode: 0o600 });
      env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = join(outside, 'secret'); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
      symlinkSync(outside, join(directory, 'escape')); env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = join(directory, 'escape', 'secret'); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
      symlinkSync(join(outside, 'secret'), join(directory, 'link')); env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = join(directory, 'link'); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
      symlinkSync(file, join(directory, 'inside-link')); env.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE = join(directory, 'inside-link'); expect(() => readGoogleConfig(directory, env)).toThrow('secret file');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('ignores test overrides outside test, even through explicit config options', () => {
    for (const mode of ['production', 'development', undefined]) {
      vi.stubEnv('NODE_ENV', mode);
      const config = readGoogleConfig(directory, { ...valid(), NODE_ENV: mode, WHITEBOARD_GOOGLE_ISSUER_OVERRIDE: 'http://attacker.invalid/secret' })!;
      expect(config).not.toHaveProperty('testIssuerOverride');
      expect(googleEndpoints({ ...config, testIssuerOverride: 'http://attacker.invalid/secret' })).toEqual({ authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' });
    }
  });

  it('uses only an exact loopback test origin for authorization, token and avatar seams', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const config = readGoogleConfig(directory, { ...valid(), NODE_ENV: 'test', WHITEBOARD_GOOGLE_ISSUER_OVERRIDE: 'http://127.0.0.1:43123' })!;
    expect(googleEndpoints(config)).toEqual({ authorizationEndpoint: 'http://127.0.0.1:43123/authorize', tokenEndpoint: 'http://127.0.0.1:43123/token', testIssuerOrigin: 'http://127.0.0.1:43123' });
    for (const bad of ['https://accounts.google.com', 'http://localhost.evil', 'http://127.1:1234', 'http://127.0.0.1:1234/path', 'http://name:password@127.0.0.1:1234']) {
      expect(() => readGoogleConfig(directory, { ...valid(), NODE_ENV: 'test', WHITEBOARD_GOOGLE_ISSUER_OVERRIDE: bad })).toThrow('test provider');
      expect(() => googleEndpoints({ ...config, testIssuerOverride: bad })).toThrow('test provider');
    }
  });

  it('adds disabled config without changing established server paths and limits', () => {
    vi.stubEnv('WHITEBOARD_DATA_DIR', directory); vi.stubEnv('WHITEBOARD_SESSION_SECRET', 'fixture-session-secret-at-least-thirty-two');
    for (const key of ['WHITEBOARD_GOOGLE_CLIENT_ID', 'WHITEBOARD_GOOGLE_CLIENT_SECRET', 'WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE', 'WHITEBOARD_PUBLIC_URL', 'WHITEBOARD_GOOGLE_ALLOWED_DOMAINS', 'WHITEBOARD_GOOGLE_ALLOWED_EMAILS']) vi.stubEnv(key, undefined);
    const config = serverConfig(); expect(config.google).toBeNull(); expect(config.databasePath).toBe(join(directory, 'whiteboard.sqlite')); expect(config.assetDirectory).toBe(join(directory, 'assets'));
    expect(config.maxUpdateBytes).toBe(4 * 1024 * 1024); expect(config.maxBoardBytes).toBe(64 * 1024 * 1024); expect(config.trustedProxy).toBe(false);
  });

  it('exposes enabled credentials privately with a canonical callback through serverConfig', () => {
    vi.stubEnv('WHITEBOARD_DATA_DIR', directory); vi.stubEnv('WHITEBOARD_SESSION_SECRET', 'fixture-session-secret-at-least-thirty-two');
    vi.stubEnv('WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE', undefined); vi.stubEnv('WHITEBOARD_GOOGLE_ALLOWED_EMAILS', undefined); vi.stubEnv('WHITEBOARD_GOOGLE_ISSUER_OVERRIDE', undefined);
    for (const [key, value] of Object.entries(valid())) vi.stubEnv(key, value);
    expect(serverConfig().google).toEqual({ clientId: 'fixture-client.apps.googleusercontent.com', clientSecret: 'fixture-secret-do-not-echo', publicOrigin: 'https://board.example', redirectUri: 'https://board.example/api/auth/google/callback', allowedDomains: ['example.com'], allowedEmails: [] });
  });
});
