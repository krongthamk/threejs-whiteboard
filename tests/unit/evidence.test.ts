import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evidenceDirectory, recordEvidence, repositoryPath, runEvidencePath, writeRunEvidence } from '../evidence';

const fixtures: string[] = [];
function temporaryDirectory(): string {
  const base = repositoryPath('test-results/evidence-regression');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'case-'));
  fixtures.push(directory);
  return directory;
}
afterEach(() => { vi.unstubAllEnvs(); for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('evidence output isolation', () => {
  it.each([undefined, '0', 'true'])('preserves historical files without the exact recording opt-in (%s)', flag => {
    vi.stubEnv('RECORD_EVIDENCE', flag);
    vi.stubEnv('RECORD_SPIKE_RESULTS', '1');
    const directory = temporaryDirectory(), source = join(directory, 'current.json'), historical = join(directory, 'history', 'report.json');
    mkdirSync(dirname(historical));
    writeFileSync(source, 'new result'); writeFileSync(historical, 'accepted evidence');
    recordEvidence(source, historical);
    expect(readFileSync(historical, 'utf8')).toBe('accepted evidence');
  });

  it('records downloaded files, screenshots and nested inspection outputs only when selected', () => {
    const directory = temporaryDirectory(), output = evidenceDirectory({ outputPath: (...segments) => join(directory, 'current-test', ...segments) });
    mkdirSync(join(output, 'inspection')); writeFileSync(join(output, 'download.pdf'), Buffer.from([1, 2, 3]));
    writeFileSync(join(output, 'inspection', 'raster.png'), Buffer.from([4, 5, 6]));
    const historical = join(directory, 'history');
    vi.stubEnv('RECORD_EVIDENCE', '0'); recordEvidence(output, historical); expect(existsSync(historical)).toBe(false);
    vi.stubEnv('RECORD_EVIDENCE', '1'); recordEvidence(output, historical);
    expect(readFileSync(join(historical, 'download.pdf'))).toEqual(Buffer.from([1, 2, 3]));
    expect(readFileSync(join(historical, 'inspection', 'raster.png'))).toEqual(Buffer.from([4, 5, 6]));
  });

  it('writes current run output while preserving historical output, then supports explicit recording', () => {
    const directory = temporaryDirectory(), suffix = relative(repositoryPath(''), directory), historical = join(directory, 'history.json');
    const suite = relative(repositoryPath('test-results/'), directory);
    writeFileSync(historical, 'accepted evidence');
    vi.stubEnv('RECORD_EVIDENCE', '0'); writeRunEvidence(suite, 'current.json', `${suffix}/history.json`, 'current result');
    expect(readFileSync(runEvidencePath(suite, 'current.json'), 'utf8')).toBe('current result');
    expect(readFileSync(historical, 'utf8')).toBe('accepted evidence');
    vi.stubEnv('RECORD_EVIDENCE', '1'); writeRunEvidence(suite, 'current.json', `${suffix}/history.json`, 'replacement evidence');
    expect(readFileSync(historical, 'utf8')).toBe('replacement evidence');
  });

  it('runs the actual model report writer from repository and package cwd without modifying historical evidence', () => {
    const historical = repositoryPath('packages/model/reports/schema2-lifecycle-retention.json');
    const digest = () => existsSync(historical) ? createHash('sha256').update(readFileSync(historical)).digest('hex') : undefined;
    const before = digest(), output = runEvidencePath('model', 'schema2-lifecycle-retention.json');
    for (const [cwd, file] of [[repositoryPath(''), 'packages/model/test/writer-storage.test.ts'], [repositoryPath('packages/model/'), 'test/writer-storage.test.ts']]) {
      rmSync(output, { force: true });
      execFileSync(process.execPath, [repositoryPath('node_modules/vitest/vitest.mjs'), 'run', file, '-t', 'measures retained generation'], {
        cwd, env: { ...process.env, RECORD_EVIDENCE: '0' }, stdio: 'pipe', timeout: 30_000,
      });
      expect(digest(), `historical report from ${cwd}`).toBe(before);
      expect(existsSync(historical), `historical report existence from ${cwd}`).toBe(before !== undefined);
      expect(existsSync(output), `current output from ${cwd}`).toBe(true);
      expect(JSON.parse(readFileSync(output, 'utf8')).samples).toHaveLength(4);
    }
    expect(existsSync(repositoryPath('packages/model/packages/model/reports/schema2-lifecycle-retention.json'))).toBe(false);
  }, 60_000);
});
