import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor every shared artifact path to this module, never to the caller's cwd.
export const repositoryPath = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
export const runEvidencePath = (suite: string, name: string): string => repositoryPath(`test-results/${suite}/${name}`);

type OutputInfo = { outputPath(...segments: string[]): string };

export function evidenceDirectory(testInfo: OutputInfo): string {
  const directory = testInfo.outputPath('evidence');
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Preserve historical evidence unless a caller explicitly opts into recording. */
export function recordEvidence(source: string, destination: string): void {
  if (process.env.RECORD_EVIDENCE !== '1' || !existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

export function recordBrowserEvidence(testInfo: OutputInfo, historicalDirectory: string): void {
  recordEvidence(testInfo.outputPath('evidence'), repositoryPath(historicalDirectory));
}

export function writeRunEvidence(suite: string, name: string, historicalPath: string, data: string | Uint8Array): void {
  const output = runEvidencePath(suite, name);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, data);
  recordEvidence(output, repositoryPath(historicalPath));
}
