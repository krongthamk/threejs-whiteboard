import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { BoardDocument, createElement } from '../../model/src/index.js';
import { Store } from './store.js';
import { gcAssets, createBackup } from './operations.js';
import { acquireMaintenanceLease } from './maintenance.js';
import { createWhiteboardServer } from './server.js';
import { BoardAssets } from '../../app/src/assets.js';
import { api } from '../../app/src/api.js';
import { createSession } from '../../app/src/session.js';
import { encodeClipboard, parseClipboard } from '../../app/src/clipboard-model.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync), copyFileSync: vi.fn(actual.copyFileSync) };
});

const secret = 'asset-maintenance-test-secret-at-least-32-characters';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whiteboard-assets-gc-')), assetDirectory = join(directory, 'assets');
  mkdirSync(assetDirectory); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'whiteboard.sqlite'), secret); cleanups.push(() => { if (store.db.open) store.close(); });
  const owner = store.createUser('owner', 'long-maintenance-password'), board = store.createBoard(owner.id, 'GC board');
  return { directory, assetDirectory, store, owner, board };
}
function asset(context: ReturnType<typeof fixture>, id: string = randomUUID(), storageKey: string = randomUUID(), boardId = context.board.id) {
  writeFileSync(join(context.assetDirectory, storageKey), `pixels:${storageKey}`);
  context.store.addAsset({ id, boardId, storageKey, mimeType: 'image/png', size: 1 });
  return { id, storageKey, path: join(context.assetDirectory, storageKey) };
}
function reference(context: ReturnType<typeof fixture>, assetId: string) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, context.store.loadDocument(context.board.id)!);
  const board = new BoardDocument(doc); board.add(createElement('image', { props: { assetId, naturalW: 1, naturalH: 1 } }));
  context.store.compact(context.board.id, Y.encodeStateAsUpdate(doc)); board.destroy(); doc.destroy();
}

test('operations gc-assets removes an orphan while preserving a referenced asset and snapshot bytes', () => {
  const context = fixture(), keep = asset(context), remove = asset(context); reference(context, keep.id);
  const before = Buffer.from(context.store.loadDocument(context.board.id)!);
  const result = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./backup-cli.ts', import.meta.url)), 'gc-assets'], {
    env: { ...process.env, WHITEBOARD_DATA_DIR: context.directory, WHITEBOARD_SESSION_SECRET: secret }, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(JSON.parse(result)).toMatchObject({ event: 'gc-assets-complete', removedAssets: 1, removedBlobs: 1, leftoverBlobs: [] });
  expect(context.store.asset(context.board.id, remove.id)).toBeUndefined(); expect(existsSync(remove.path)).toBe(false);
  expect(context.store.asset(context.board.id, keep.id)).toBeDefined(); expect(readFileSync(keep.path, 'utf8')).toContain('pixels:');
  expect(Buffer.from(context.store.loadDocument(context.board.id)!)).toEqual(before);
});

test('GC retains raw losing generations, props overrides and readable malformed records with opaque asset IDs', () => {
  const context = fixture(), retained = [asset(context, 'opaque asset id/☃'), asset(context), asset(context), asset(context)], remove = asset(context);
  const doc = new Y.Doc(); Y.applyUpdate(doc, context.store.loadDocument(context.board.id)!);
  doc.getArray('element-properties:old-peer').push([
    { key: '["image","$base"]', val: { stamp: { actor: 'old-peer', clock: 1 }, value: { generation: 'lost', element: createElement('image', { id: 'image', props: { assetId: retained[0]!.id, naturalW: 1, naturalH: 1 } }) } } },
    { key: '["image","lost","props"]', val: { stamp: { actor: 'old-peer', clock: 2 }, value: { assetId: retained[1]!.id, naturalW: 1, naturalH: 1 } } },
    { key: 'broken historical key', val: { malformed: true, nested: { assetId: retained[2]!.id } } },
  ]);
  doc.getArray('element-properties:new-peer').push([
    { key: '["image","$base"]', val: { stamp: { actor: 'new-peer', clock: 3 }, value: { generation: 'winning', element: createElement('image', { id: 'image', props: { assetId: retained[3]!.id, naturalW: 1, naturalH: 1 } }) } } },
  ]);
  context.store.compact(context.board.id, Y.encodeStateAsUpdate(doc)); doc.destroy();
  const before = Buffer.from(context.store.loadDocument(context.board.id)!);
  expect(gcAssets(context.store, context.assetDirectory)).toEqual({ removedAssets: 1, removedBlobs: 1, leftoverBlobs: [] });
  for (const value of retained) { expect(existsSync(value.path)).toBe(true); expect(context.store.asset(context.board.id, value.id)).toBeDefined(); }
  expect(existsSync(remove.path)).toBe(false); expect(Buffer.from(context.store.loadDocument(context.board.id)!)).toEqual(before);
});

test.each(['text-embed', 'xml-attribute'])('GC fails closed on unsupported nested Yjs %s without serializing away its references', kind => {
  const context = fixture(), keep = asset(context), remove = asset(context), doc = new Y.Doc();
  Y.applyUpdate(doc, context.store.loadDocument(context.board.id)!);
  const map = new Y.Map();
  if (kind === 'text-embed') { const text = new Y.Text(); text.insertEmbed(0, { assetId: keep.id }); map.set('props', text); }
  else { const xml = new Y.XmlElement('image'); xml.setAttribute('assetId', keep.id); map.set('props', xml); }
  doc.getArray('element-properties:historical').push([map]);
  context.store.compact(context.board.id, Y.encodeStateAsUpdate(doc)); doc.destroy();
  const beforeRows = context.store.db.prepare('SELECT * FROM assets').all(), beforeBytes = Buffer.from(context.store.loadDocument(context.board.id)!);
  expect(() => gcAssets(context.store, context.assetDirectory)).toThrow();
  expect(context.store.db.prepare('SELECT * FROM assets').all()).toEqual(beforeRows);
  expect(existsSync(keep.path)).toBe(true); expect(existsSync(remove.path)).toBe(true);
  expect(Buffer.from(context.store.loadDocument(context.board.id)!)).toEqual(beforeBytes);
});

test.each(['own-reference', 'prototype-reference'])('GC fails closed on decoded unusual prototypes with %s', kind => {
  const context = fixture(), keep = asset(context), remove = asset(context), doc = new Y.Doc();
  Y.applyUpdate(doc, context.store.loadDocument(context.board.id)!);
  const raw: unknown = JSON.parse(kind === 'own-reference'
    ? `{"assetId":${JSON.stringify(keep.id)},"__proto__":{"historical":true}}`
    : `{"__proto__":{"assetId":${JSON.stringify(keep.id)}}}`);
  doc.getArray('element-properties:historical').push([raw]);
  context.store.compact(context.board.id, Y.encodeStateAsUpdate(doc)); doc.destroy();
  const before = context.store.db.prepare('SELECT * FROM assets').all(), bytes = Buffer.from(context.store.loadDocument(context.board.id)!);
  expect(() => gcAssets(context.store, context.assetDirectory)).toThrow();
  expect(context.store.db.prepare('SELECT * FROM assets').all()).toEqual(before);
  expect(existsSync(keep.path)).toBe(true); expect(existsSync(remove.path)).toBe(true);
  expect(Buffer.from(context.store.loadDocument(context.board.id)!)).toEqual(bytes);
});

test('GC removes an unreferenced cross-board copy row without unlinking its shared live storage key', () => {
  const context = fixture(), source = asset(context), target = context.store.createBoard(context.owner.id, 'Target'), copiedId = randomUUID();
  reference(context, source.id);
  context.store.addAsset({ ...context.store.asset(context.board.id, source.id)!, id: copiedId, boardId: target.id });
  const remove = asset(context, randomUUID(), randomUUID(), target.id);
  expect(gcAssets(context.store, context.assetDirectory)).toEqual({ removedAssets: 2, removedBlobs: 1, leftoverBlobs: [] });
  expect(context.store.asset(target.id, copiedId)).toBeUndefined(); expect(existsSync(source.path)).toBe(true); expect(existsSync(remove.path)).toBe(false);
});

test('real cross-board clipboard import and native model undo leave copied assets collectable while unrelated assets remain', async () => {
  const context = fixture(), app = createWhiteboardServer({ databasePath: context.store.filename, assetDirectory: context.assetDirectory, sessionSecret: secret, port: 0 });
  await app.listen(); cleanups.push(() => app.close());
  const token = (await app.store.login(context.owner.username, 'long-maintenance-password'))!.token;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const uploaded = await (await fetch(`http://127.0.0.1:${app.port}/api/boards/${context.board.id}/assets`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: bytes,
  })).json() as { assetId: string };
  const sourceDoc = new Y.Doc(); Y.applyUpdate(sourceDoc, app.store.loadDocument(context.board.id)!);
  const source = new BoardDocument(sourceDoc), sourceImage = createElement('image', { props: { assetId: uploaded.assetId, naturalW: 1, naturalH: 1 } });
  source.add(sourceImage); app.store.compact(context.board.id, Y.encodeStateAsUpdate(sourceDoc));
  const target = app.store.createBoard(context.owner.id, 'Paste target'), unrelated = asset(context, randomUUID(), randomUUID(), target.id);
  const targetDoc = new Y.Doc(); Y.applyUpdate(targetDoc, app.store.loadDocument(target.id)!);
  const targetBoard = new BoardDocument(targetDoc), keepImage = createElement('image', { id: 'unrelated', props: { assetId: unrelated.id, naturalW: 1, naturalH: 1 } });
  targetBoard.add(keepImage); targetBoard.undoManager.clear();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const session = createSession(target.id), errors: string[] = [];
  const assets = new BoardAssets({ canvas: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLCanvasElement,
    boardId: target.id, board: targetBoard, session, isReadOnly: () => false, maxImageDimension: () => 16384, onError: message => errors.push(message) });
  vi.spyOn(api, 'copyAsset').mockImplementation(async (boardId, sourceBoardId, assetId) => {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/boards/${boardId}/assets/copy`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceBoardId, assetId }),
    });
    expect(response.status).toBe(201); return response.json();
  });
  try {
    const envelope = parseClipboard(encodeClipboard(context.board.id, [sourceImage.id], source.readAll()))!;
    await (assets as unknown as { importClipboard(value: typeof envelope): Promise<void> }).importClipboard(envelope);
    expect(errors).toEqual([]); expect(targetBoard.readAll()).toHaveLength(2);
    const pasted = targetBoard.readAll().find(element => element.id !== keepImage.id)!;
    if (pasted.type !== 'image') throw Error('Expected pasted image');
    const copiedId = pasted.props.assetId, sharedKey = app.store.asset(target.id, copiedId)!.storageKey;
    targetBoard.undoManager.undo(); expect(targetBoard.readAll()).toEqual([keepImage]);
    app.store.compact(target.id, Y.encodeStateAsUpdate(targetDoc));
    const before = Buffer.from(app.store.loadDocument(target.id)!); await app.close();
    expect(gcAssets(context.store, context.assetDirectory)).toEqual({ removedAssets: 1, removedBlobs: 0, leftoverBlobs: [] });
    expect(context.store.asset(target.id, copiedId)).toBeUndefined();
    expect(context.store.asset(target.id, unrelated.id)).toBeDefined(); expect(existsSync(unrelated.path)).toBe(true);
    expect(readFileSync(join(context.assetDirectory, sharedKey))).toEqual(bytes);
    expect(Buffer.from(context.store.loadDocument(target.id)!)).toEqual(before);
  } finally { assets.destroy(); session.dispose(); source.destroy(); sourceDoc.destroy(); targetBoard.destroy(); targetDoc.destroy(); }
});

test('GC sweeps interrupted UUID uploads while preserving unrelated leaves and safe legacy row keys', () => {
  const context = fixture(), leftover = randomUUID(), old = asset(context, 'old-id', 'legacy-blob');
  writeFileSync(join(context.assetDirectory, leftover), 'interrupted upload');
  for (const name of ['session-secret', 'operator-notes', 'foreign.sqlite']) writeFileSync(join(context.assetDirectory, name), name);
  expect(gcAssets(context.store, context.assetDirectory)).toEqual({ removedAssets: 1, removedBlobs: 2, leftoverBlobs: [] });
  expect(existsSync(old.path)).toBe(false); expect(existsSync(join(context.assetDirectory, leftover))).toBe(false);
  for (const name of ['session-secret', 'operator-notes', 'foreign.sqlite']) expect(readFileSync(join(context.assetDirectory, name), 'utf8')).toBe(name);
});

test.each(['unknown-schema', 'missing-schema', 'unknown-root', 'corrupt-bytes', 'missing-document', 'pending-structs', 'pending-delete-set'])('GC fails closed without row or blob changes for %s', fault => {
  const context = fixture(), remove = asset(context), beforeAssets = context.store.db.prepare('SELECT * FROM assets').all();
  const doc = new Y.Doc(); Y.applyUpdate(doc, context.store.loadDocument(context.board.id)!);
  if (fault === 'unknown-schema') doc.getMap('meta').set('schemaVersion', 100);
  if (fault === 'missing-schema') doc.getMap('meta').delete('schemaVersion');
  if (fault === 'unknown-root') doc.getMap('avatar-assets').set('assetId', remove.id);
  if (fault === 'missing-document') context.store.db.prepare('DELETE FROM documents WHERE board_id=?').run(context.board.id);
  else if (fault === 'corrupt-bytes') context.store.compact(context.board.id, new Uint8Array([255, 255, 255]));
  else if (fault.startsWith('pending-')) {
    const source = new Y.Doc(), first: Uint8Array[] = [], second: Uint8Array[] = [];
    const updates: Uint8Array[] = []; source.on('update', update => updates.push(update));
    source.getArray('element-properties:peer').push([{ val: { value: { assetId: remove.id } } }]); first.push(updates.shift()!);
    if (fault === 'pending-structs') source.getArray('element-properties:peer').push(['requires first item']);
    else source.getArray('element-properties:peer').delete(0);
    second.push(updates.shift()!);
    context.store.compact(context.board.id, Y.mergeUpdates([context.store.loadDocument(context.board.id)!, ...second])); source.destroy();
  } else context.store.compact(context.board.id, Y.encodeStateAsUpdate(doc));
  doc.destroy();
  expect(() => gcAssets(context.store, context.assetDirectory)).toThrow();
  expect(context.store.db.prepare('SELECT * FROM assets').all()).toEqual(beforeAssets); expect(existsSync(remove.path)).toBe(true);
});

test.each(['root', 'contains-db', 'root-symlink', 'traversal-key', 'blob-symlink', 'uuid-directory'])('GC refuses unsafe %s without asset mutations', fault => {
  const context = fixture(), remove = asset(context), before = context.store.db.prepare('SELECT * FROM assets').all();
  let directory = context.assetDirectory;
  if (fault === 'root') directory = '/';
  if (fault === 'contains-db') directory = context.directory;
  if (fault === 'root-symlink') { directory = join(context.directory, 'alias-assets'); symlinkSync(context.assetDirectory, directory); }
  if (fault === 'traversal-key') context.store.db.prepare('UPDATE assets SET storage_key=? WHERE id=?').run('../session-secret', remove.id);
  if (fault === 'blob-symlink') { fs.unlinkSync(remove.path); symlinkSync(join(context.directory, 'whiteboard.sqlite'), remove.path); }
  if (fault === 'uuid-directory') mkdirSync(join(context.assetDirectory, randomUUID()));
  const rows = fault === 'traversal-key' ? context.store.db.prepare('SELECT * FROM assets').all() : before;
  expect(() => gcAssets(context.store, directory)).toThrow(); expect(context.store.db.prepare('SELECT * FROM assets').all()).toEqual(rows); expect(existsSync(remove.path)).toBe(true);
});

test('GC refuses an asset directory containing a configured database alias even when its real DB is outside', () => {
  const context = fixture(), remove = asset(context), alias = join(context.assetDirectory, 'database-alias');
  symlinkSync(context.store.filename, alias);
  const aliased = new Store(alias, secret);
  try { expect(() => gcAssets(aliased, context.assetDirectory)).toThrow('contains database'); }
  finally { aliased.close(); }
  expect(context.store.asset(context.board.id, remove.id)).toBeDefined(); expect(existsSync(remove.path)).toBe(true);
});

test('failed SQL deletion rolls back all rows before any file is unlinked', () => {
  const context = fixture(), first = asset(context), second = asset(context);
  context.store.db.exec("CREATE TRIGGER fail_asset_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT,'forced deletion failure'); END");
  expect(() => gcAssets(context.store, context.assetDirectory)).toThrow('forced deletion failure');
  expect(context.store.asset(context.board.id, first.id)).toBeDefined(); expect(context.store.asset(context.board.id, second.id)).toBeDefined();
  expect(existsSync(first.path)).toBe(true); expect(existsSync(second.path)).toBe(true);
});

test('postcommit unlink failure reports leftover blob, preserves live blobs and is retried safely', () => {
  const context = fixture(), keep = asset(context), remove = asset(context); reference(context, keep.id);
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(path => {
    expect(context.store.asset(context.board.id, remove.id)).toBeUndefined();
    expect(String(path)).toBe(remove.path); throw new Error('forced unlink failure');
  });
  expect(gcAssets(context.store, context.assetDirectory)).toEqual({ removedAssets: 1, removedBlobs: 0, leftoverBlobs: [remove.storageKey] });
  expect(existsSync(keep.path)).toBe(true); expect(existsSync(remove.path)).toBe(true); unlink.mockRestore();
  expect(gcAssets(context.store, context.assetDirectory)).toEqual({ removedAssets: 0, removedBlobs: 1, leftoverBlobs: [] });
  expect(existsSync(keep.path)).toBe(true); expect(existsSync(remove.path)).toBe(false);
});

function processFixture(context: ReturnType<typeof fixture>, mode: 'server' | 'backup', databasePath = context.store.filename) {
  const entry = join(context.directory, `child-${mode}-${randomUUID()}.mjs`);
  const imports = (name: string) => new URL(name, import.meta.url).href;
  const options = { databasePath, assetDirectory: context.assetDirectory, sessionSecret: secret, port: 0 };
  writeFileSync(entry, mode === 'server' ? `
    import { createWhiteboardServer } from ${JSON.stringify(imports('./server.ts'))};
    const app = createWhiteboardServer(${JSON.stringify(options)});
    process.on('message', async message => { if (message.type === 'stop') { await app.close(); process.disconnect(); } });
    await app.listen(); process.send({ type: 'ready' });
  ` : `
    import { Store } from ${JSON.stringify(imports('./store.ts'))};
    import { createBackup } from ${JSON.stringify(imports('./operations.ts'))};
    const store = new Store(${JSON.stringify(databasePath)}, ${JSON.stringify(secret)});
    const original = store.backup.bind(store);
    const resume = new Promise(resolve => process.on('message', message => { if (message.type === 'continue') resolve(); }));
    store.backup = async path => { await original(path); process.send({ type: 'snapshot-ready' }); await resume; };
    try { await createBackup(store, ${JSON.stringify(context.assetDirectory)}, ${JSON.stringify(secret)}, ${JSON.stringify(join(context.directory, 'child-backup'))}); process.send({ type: 'backup-done' }); }
    finally { store.close(); process.disconnect(); }
  `);
  const child = fork(entry, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const events = new Map<string, unknown>(); let diagnostics = '';
  child.on('message', value => { if (value && typeof value === 'object' && 'type' in value) events.set(String(value.type), value); });
  child.stderr!.on('data', bytes => { diagnostics += String(bytes); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  async function event(type: string) {
    const deadline = Date.now() + 5000;
    while (!events.has(type)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Child did not emit ${type}: ${diagnostics.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function exit(timeout = 3000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Child exit timeout')), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit(); }
  });
  return { child, event, exit };
}

test('a real running server excludes GC through a canonical directory alias; process death releases its lease', async () => {
  const context = fixture(), remove = asset(context), alias = join(context.directory, 'data-alias');
  symlinkSync(context.directory, alias);
  const running = processFixture(context, 'server', join(alias, 'whiteboard.sqlite')); await running.event('ready');
  expect(() => gcAssets(context.store, context.assetDirectory)).toThrow('busy');
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./backup-cli.ts', import.meta.url)), 'gc-assets'], {
    env: { ...process.env, WHITEBOARD_DATA_DIR: context.directory, WHITEBOARD_SESSION_SECRET: secret }, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  })).toThrow();
  expect(existsSync(remove.path)).toBe(true); expect(context.store.asset(context.board.id, remove.id)).toBeDefined();
  running.child.kill('SIGKILL'); await running.exit();
  expect(gcAssets(context.store, context.assetDirectory).removedAssets).toBe(1); expect(existsSync(remove.path)).toBe(false);
});

test('an exclusive GC lease prevents server construction before main Store mutation, including a new DB alias', () => {
  const context = fixture(), main = join(context.directory, 'new.sqlite'), alias = join(context.directory, 'alias'); symlinkSync(context.directory, alias);
  const exclusive = acquireMaintenanceLease(main, 'exclusive');
  try {
    expect(() => createWhiteboardServer({ databasePath: join(alias, 'new.sqlite'), assetDirectory: context.assetDirectory, sessionSecret: secret, port: 0 })).toThrow('busy');
    expect(existsSync(main)).toBe(false);
  } finally { exclusive.release(); }
  const app = createWhiteboardServer({ databasePath: main, assetDirectory: context.assetDirectory, sessionSecret: secret, port: 0 });
  cleanups.push(() => app.close()); expect(existsSync(main)).toBe(true);
});

test('a dangling maintenance symlink is rejected before its target can be created or chmodded', () => {
  const context = fixture(), target = join(context.directory, 'must-not-create.sqlite');
  symlinkSync(target, `${context.store.filename}.maintenance.sqlite`);
  expect(() => acquireMaintenanceLease(context.store.filename, 'shared')).toThrow('Unsafe maintenance lease path');
  expect(existsSync(target)).toBe(false);
});

test('real async backup excludes GC from DB snapshot through asset copies and releases after completion', async () => {
  const context = fixture(), keep = asset(context), remove = asset(context); reference(context, keep.id);
  const backup = processFixture(context, 'backup'); await backup.event('snapshot-ready');
  expect(() => gcAssets(context.store, context.assetDirectory)).toThrow('busy'); expect(existsSync(remove.path)).toBe(true);
  backup.child.send({ type: 'continue' }); await backup.event('backup-done'); expect(await backup.exit()).toBe(0);
  expect(readFileSync(join(context.directory, 'child-backup/assets', remove.storageKey), 'utf8')).toBe(readFileSync(remove.path, 'utf8'));
  expect(gcAssets(context.store, context.assetDirectory).removedAssets).toBe(1); expect(existsSync(keep.path)).toBe(true);
});

test('backup holds its shared lease during synchronous asset copy and releases on copy failure', async () => {
  const context = fixture(), remove = asset(context);
  const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
    expect(() => gcAssets(context.store, context.assetDirectory)).toThrow('busy'); throw Error('forced backup copy failure');
  });
  await expect(createBackup(context.store, context.assetDirectory, secret, join(context.directory, 'failed-backup'))).rejects.toThrow('forced backup copy failure');
  copy.mockRestore(); expect(existsSync(remove.path)).toBe(true);
  expect(gcAssets(context.store, context.assetDirectory).removedAssets).toBe(1);
});

test('constructor, listen and close failures release server maintenance leases', async () => {
  const context = fixture(), options = { databasePath: context.store.filename, assetDirectory: context.assetDirectory, sessionSecret: secret, port: 0 };
  expect(() => createWhiteboardServer({ ...options, sessionSecret: 'short' })).toThrow();
  acquireMaintenanceLease(context.store.filename, 'exclusive').release();
  const badAssets = join(context.directory, 'not-a-directory'); writeFileSync(badAssets, 'bad');
  expect(() => createWhiteboardServer({ ...options, assetDirectory: badAssets })).toThrow();
  acquireMaintenanceLease(context.store.filename, 'exclusive').release();
  const listenFailure = createWhiteboardServer(options);
  vi.spyOn(listenFailure.server, 'listen').mockRejectedValueOnce(Error('forced listen failure'));
  await expect(listenFailure.listen()).rejects.toThrow('forced listen failure');
  acquireMaintenanceLease(context.store.filename, 'exclusive').release(); await listenFailure.close();
  const closeFailure = createWhiteboardServer(options), destroy = closeFailure.server.destroy.bind(closeFailure.server);
  vi.spyOn(closeFailure.server, 'destroy').mockImplementation(async () => { await destroy(); throw Error('forced close failure'); });
  await expect(closeFailure.close()).rejects.toThrow('forced close failure');
  acquireMaintenanceLease(context.store.filename, 'exclusive').release();
});

test('database file aliases share the same lease and multiple shared servers remain compatible', async () => {
  const context = fixture(), alias = join(context.directory, 'alias.sqlite'); symlinkSync(context.store.filename, alias);
  const options = { databasePath: alias, assetDirectory: context.assetDirectory, sessionSecret: secret, port: 0 };
  const first = createWhiteboardServer(options), second = createWhiteboardServer({ ...options, databasePath: realpathSync(context.store.filename) });
  cleanups.push(() => first.close()); cleanups.push(() => second.close());
  expect(() => acquireMaintenanceLease(context.store.filename, 'exclusive')).toThrow('busy');
  await first.close(); expect(() => acquireMaintenanceLease(alias, 'exclusive')).toThrow('busy');
  await second.close(); acquireMaintenanceLease(alias, 'exclusive').release();
});
