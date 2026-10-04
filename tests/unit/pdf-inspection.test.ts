import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfInspectionEnvironment } from '../pdf-inspection';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('loads PDF inspection dependencies from the configured Python path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-pdf-path-')); directories.push(directory);
  writeFileSync(join(directory, 'whiteboard_pdf_path_fixture.py'), 'value = "custom inspection path"\n');
  const environment = { ...process.env, PYTHONPATH: '/missing/original/path', PDF_PYTHONPATH: directory };
  const result = execFileSync('python3', ['-c', 'import whiteboard_pdf_path_fixture; print(whiteboard_pdf_path_fixture.value)'], { env: pdfInspectionEnvironment(environment), encoding: 'utf8' });
  expect(result.trim()).toBe('custom inspection path'); expect(environment.PYTHONPATH).toBe('/missing/original/path');
});

it('keeps Python installation defaults and an existing Python path when no PDF override is requested', () => {
  expect(pdfInspectionEnvironment({ PYTHONPATH: '/existing/python/path' }).PYTHONPATH).toBe('/existing/python/path');
  expect(pdfInspectionEnvironment({}).PYTHONPATH).toBeUndefined();
});
