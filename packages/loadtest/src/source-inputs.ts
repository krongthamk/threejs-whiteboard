import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
/** Read sources only when requested; importing this module never starts a workload. */
export function captureSourceInputs(production: boolean): Record<string, string> {
  const paths = ['packages/loadtest/src/run-writer-kv.ts', 'packages/loadtest/src/source-inputs.ts',
    'packages/loadtest/src/writer-client-worker.ts', 'packages/loadtest/src/spike-writer-kv.ts',
    'spikes/model-kv/writer-model.ts', 'spikes/model-kv/model.ts', 'spikes/package.json',
    'packages/loadtest/package.json', 'packages/server/package.json', 'packages/model/package.json', 'pnpm-lock.yaml'];
  if (production) {
    paths.push('packages/loadtest/src/production-client-worker.ts', 'packages/loadtest/src/production-identity.ts', 'packages/loadtest/src/benchmark.ts');
    paths.push(...readdirSync(join(repositoryRoot, 'packages/server/src')).filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts')).map(path => `packages/server/src/${path}`));
  }
  paths.push(...readdirSync(join(repositoryRoot, 'packages/model/src')).filter(path => /\.(ts|json)$/.test(path)).map(path => `packages/model/src/${path}`));
  return Object.fromEntries([...new Set(paths)].map(path => [path, readFileSync(join(repositoryRoot, path), 'utf8')]));
}

/** Freeze workspace sources; external dependency versions remain pinned by the captured lockfile. */
export function freezeSourceInputs(inputs: Record<string, string>, frozenRoot: string): void {
  mkdirSync(frozenRoot);
  for (const [path, content] of Object.entries(inputs)) {
    const destination = join(frozenRoot, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content);
  }
  writeFileSync(join(frozenRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  const scopes = ['packages/model', 'packages/server', 'packages/loadtest', 'spikes'];
  const workspaces = new Map(scopes.map(scope => [(JSON.parse(inputs[`${scope}/package.json`]!) as { name: string }).name, scope]));
  for (const scope of ['', ...scopes]) {
    const original = join(repositoryRoot, scope, 'node_modules'), destination = join(frozenRoot, scope, 'node_modules');
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(original, { withFileTypes: true })) {
      if (entry.name === '@whiteboard') {
        mkdirSync(join(destination, entry.name));
        for (const name of readdirSync(join(original, entry.name))) {
          const captured = workspaces.get(`@whiteboard/${name}`);
          // Unused workspace packages are intentionally absent, never linked
          // back to mutable repository source files.
          if (captured) symlinkSync(join(frozenRoot, captured), join(destination, entry.name, name), 'dir');
        }
      } else symlinkSync(join(original, entry.name), join(destination, entry.name), entry.isDirectory() ? 'dir' : 'file');
    }
  }
}
