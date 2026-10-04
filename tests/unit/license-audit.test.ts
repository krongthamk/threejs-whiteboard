import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/license-audit.mjs', import.meta.url));
function audit(licenses: string[], names?: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-license-policy-'));
  try {
    mkdirSync(join(directory, 'node_modules'));
    writeFileSync(join(directory, 'node_modules/.modules.yaml'), 'storeDir: /unused-policy-test-store\n');
    const fixture = join(directory, 'licenses.json');
    writeFileSync(fixture, JSON.stringify(Object.fromEntries(licenses.map((license, i) => [license, [{ name: names?.[i] ?? `fixture-${i}`, versions: ['1.0.0'] }]]))));
    // Exercise the actual CLI with a deterministic pnpm license inventory, without installing packages.
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\n/bin/cat "$WHITEBOARD_LICENSE_FIXTURE"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: {
      ...process.env, PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`, WHITEBOARD_LICENSE_FIXTURE: fixture,
    } });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('license audit accepts each explicitly allowed SPDX identifier', () => {
  expect(audit(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0', 'Unlicense', 'OFL-1.1']).status).toBe(0);
});

test('license audit rejects unknown, missing and every license outside the allowlist', () => {
  const licenses = ['GPL-3.0-only', 'LGPL-2.1-only', 'SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-4.0', 'Unknown', '', 'MPL-2.0', 'Zlib', '(MIT AND Zlib)'];
  const result = audit(licenses);
  expect(result.status).toBe(1);
  for (const [i, license] of licenses.entries()) expect(result.output).toContain(`fixture-${i}@1.0.0: ${license}`);
});

test('license audit retains explicit exclusions even with an allowed license label', () => {
  const result = audit(['MIT', 'ISC', 'Apache-2.0'], ['tldraw', '@tldraw/editor', '@y/hub']);
  expect(result.status).toBe(1);
  for (const name of ['tldraw', '@tldraw/editor', '@y/hub']) expect(result.output).toContain(name);
});

// A valid compound expression never grants permission to an unapproved branch.
test('license audit accepts valid expressions composed only of allowlisted identifiers', () => {
  expect(audit(['Apache-2.0 AND MIT', '(MIT OR ISC)', 'MIT AND (BSD-2-Clause OR Apache-2.0)']).status).toBe(0);
});
test('license audit rejects unapproved branches and malformed expressions', () => {
  for (const license of ['MIT OR GPL-3.0-only', '(MPL-2.0 OR Apache-2.0)', 'MIT ISC', 'MIT AND', 'AND MIT', 'MIT OR OR ISC', '(MIT AND ISC', 'MIT AND ISC)', '()', 'MIT WITH Classpath-exception-2.0', 'MIT+', 'MIT\nOR ISC', 'MIT\u2028OR ISC', 'MIT\u2029OR ISC', 'MIT\vOR ISC']) expect(audit([license]).status, license).toBe(1);
});
