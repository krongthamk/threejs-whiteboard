import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentEnvironment, deploymentEnvironmentXml } from '../../scripts/deploy-environment.js';
import { readGoogleConfig } from '../../packages/server/src/google-config.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function paths() {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'whiteboard-deploy-env-')); directories.push(dataDirectory);
  chmodSync(dataDirectory, 0o700);
  return { dataDirectory, staticDirectory: '/checkout/packages/app/dist' };
}
const inline: NodeJS.ProcessEnv = { WHITEBOARD_GOOGLE_CLIENT_ID: 'operator-client.apps.googleusercontent.com',
  WHITEBOARD_GOOGLE_CLIENT_SECRET: 'inline-test-marker<&\"', WHITEBOARD_PUBLIC_URL: 'http://127.0.0.1:3001',
  WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: 'example.test', WHITEBOARD_GOOGLE_ALLOWED_EMAILS: 'Extra+Member@Example.test' };

describe('local deployment launch environment', () => {
  it('preserves the fixed default loopback production environment', () => {
    const input = paths(), result = deploymentEnvironment(input, {});
    expect(result).toEqual({ WHITEBOARD_DATA_DIR: input.dataDirectory, WHITEBOARD_STATIC_DIR: input.staticDirectory,
      WHITEBOARD_ORIGINS: 'http://127.0.0.1:3001,http://localhost:3001', HOST: '127.0.0.1', PORT: '3001',
      NODE_ENV: 'production', WHITEBOARD_DRAIN_MS: '5000' });
    expect(readGoogleConfig(input.dataDirectory, result)).toBeNull(); expect(Object.isFrozen(result)).toBe(true);
  });
  it('launches a complete inline Google configuration with all six explicitly supported selectors', () => {
    const input = paths(), result = deploymentEnvironment(input, inline), config = readGoogleConfig(input.dataDirectory, result);
    expect(config).toMatchObject({ clientId: inline.WHITEBOARD_GOOGLE_CLIENT_ID, clientSecret: inline.WHITEBOARD_GOOGLE_CLIENT_SECRET,
      redirectUri: 'http://127.0.0.1:3001/api/auth/google/callback', allowedDomains: ['example.test'], allowedEmails: ['extra+member@example.test'] });
    for (const [key, value] of Object.entries(inline)) expect(result[key]).toBe(value);
  });
  it('passes the raw private-file selector without decoding its secret into the launch environment', () => {
    const input = paths(), selector = 'google<&\".secret', secret = 'private-file-only-marker';
    writeFileSync(join(input.dataDirectory, selector), secret + '\n', { mode: 0o600 });
    const { WHITEBOARD_GOOGLE_CLIENT_SECRET: _inline, ...rest } = inline;
    const result = deploymentEnvironment(input, { ...rest, WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE: selector });
    expect(readGoogleConfig(input.dataDirectory, result)?.clientSecret).toBe(secret);
    expect(result.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE).toBe(selector); expect(result).not.toHaveProperty('WHITEBOARD_GOOGLE_CLIENT_SECRET');
    expect(JSON.stringify(result)).not.toContain(secret); expect(deploymentEnvironmentXml(result)).not.toContain(secret);
    expect(deploymentEnvironmentXml(result)).toContain('<key>WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE</key><string>google&lt;&amp;&quot;.secret</string>');
  });
  it('keeps a partial configuration disabled without reading a nonexistent secret file', () => {
    const input = paths();
    const result = deploymentEnvironment(input, { WHITEBOARD_GOOGLE_CLIENT_ID: inline.WHITEBOARD_GOOGLE_CLIENT_ID,
      WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE: 'missing.secret', WHITEBOARD_GOOGLE_ALLOWED_DOMAINS: '', WHITEBOARD_PUBLIC_URL: '' });
    expect(result.WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE).toBe('missing.secret');
    expect(readGoogleConfig(input.dataDirectory, result)).toBeNull();
  });
  it('does not forward ambient credentials, test overrides, networking settings, or arbitrary environment', () => {
    const input = paths(), result = deploymentEnvironment(input, { ...inline, NODE_ENV: 'test', HOST: '0.0.0.0', PORT: '9999',
      WHITEBOARD_GOOGLE_ISSUER_OVERRIDE: 'http://127.0.0.1:9999', WHITEBOARD_PASSWORD: 'password-marker',
      WHITEBOARD_SESSION_SECRET: 'session-marker', WHITEBOARD_TEST_GOOGLE: '1', WHITEBOARD_SECURE_COOKIES: '1',
      WHITEBOARD_ORIGINS: 'https://foreign.test', WHITEBOARD_DATA_DIR: '/foreign', HOME: '/foreign', PATH: '/foreign' });
    expect(result.NODE_ENV).toBe('production'); expect(result.HOST).toBe('127.0.0.1'); expect(result.PORT).toBe('3001');
    expect(result.WHITEBOARD_DATA_DIR).toBe(input.dataDirectory);
    for (const key of ['WHITEBOARD_GOOGLE_ISSUER_OVERRIDE', 'WHITEBOARD_PASSWORD', 'WHITEBOARD_SESSION_SECRET', 'WHITEBOARD_TEST_GOOGLE', 'WHITEBOARD_SECURE_COOKIES', 'HOME', 'PATH']) expect(result).not.toHaveProperty(key);
    expect(readGoogleConfig(input.dataDirectory, result)).not.toHaveProperty('testIssuerOverride');
  });
  it('serializes supported XML-significant values through the launch dictionary serializer', () => {
    const input = paths(), result = deploymentEnvironment({ ...input, staticDirectory: '/checkout/<app>&\"dist\'' }, inline);
    const serialized = deploymentEnvironmentXml(result);
    expect(serialized).toContain('<key>WHITEBOARD_GOOGLE_CLIENT_SECRET</key><string>inline-test-marker&lt;&amp;&quot;</string>');
    expect(serialized).toContain('<key>WHITEBOARD_STATIC_DIR</key><string>/checkout/&lt;app&gt;&amp;&quot;dist&apos;</string>');
    expect(serialized).not.toContain('inline-test-marker<&');
  });
  it('rejects a complete invalid derived configuration with a sanitized error', () => {
    const input = paths(), result = deploymentEnvironment(input, { ...inline, WHITEBOARD_PUBLIC_URL: 'http://untrusted.test' });
    try { readGoogleConfig(input.dataDirectory, result); expect.fail('Invalid public URL must be rejected'); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invalid Google sign-in configuration (public URL).');
      expect((error as Error).message).not.toContain(inline.WHITEBOARD_GOOGLE_CLIENT_SECRET);
      expect((error as Error).message).not.toContain('http://untrusted.test');
    }
  });
});
