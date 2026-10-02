// Run with node --import tsx. Runtime/model imports deliberately target the exact baseline checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const BASELINE = 'fed369b245f7b2fbade7b8cde52ef869647f4ad8';
const baseline = realpathSync(resolve(process.argv[2] ?? ''));
const output = resolve(process.argv[3] ?? dirname(fileURLToPath(import.meta.url)));
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(), BASELINE);
const sourceFiles = ['packages/server/src/store.ts', ...execFileSync('git', ['ls-tree', '-r', '--name-only', BASELINE, 'packages/model/src'], { cwd: baseline, encoding: 'utf8' }).trim().split('\n')];
const sources = sourceFiles.map(relative => {
  const absolute = realpathSync(join(baseline, relative));
  assert.ok(absolute.startsWith(baseline + '/'), `Source escaped baseline: ${absolute}`);
  const bytes = readFileSync(absolute);
  assert.deepEqual(bytes, execFileSync('git', ['show', `${BASELINE}:${relative}`], { cwd: baseline }), `Modified baseline: ${relative}`);
  return { path: relative, importedSourcePath: absolute, gitBlob: execFileSync('git', ['rev-parse', `${BASELINE}:${relative}`], { cwd: baseline, encoding: 'utf8' }).trim(), sha256: hash(bytes) };
});
const storeUrl = pathToFileURL(join(baseline, 'packages/server/src/store.ts')).href;
const modelUrl = pathToFileURL(join(baseline, 'packages/model/src/index.ts')).href;
const { Store } = await import(storeUrl);
const { BoardDocument, bindToElement, documentToSvg } = await import(modelUrl);
const Y = await import(pathToFileURL(join(baseline, 'node_modules/yjs/dist/yjs.mjs')).href);
// These assertions distinguish the imported baseline implementation from current review fixes.
assert.match(BoardDocument.toString(), /YKeyValue|own\.kv/);
assert.doesNotMatch(Store.toString(), /assertUpdateFits|BoardFullError/);

const filename = join(output, 'schema2-pre-f1.sqlite');
assert.ok(!existsSync(filename), 'Refusing to overwrite the historical fixture; generate into a fresh directory.');
mkdirSync(join(output, 'assets'), { recursive: true });
const png = syntheticPng();
const assetId = 'legacy-image-1', storageKey = 'assets/legacy-image-1.png';
writeFileSync(join(output, storageKey), png);
const secret = 'synthetic-fixture-session-secret-only-DO-NOT-DEPLOY';
const password = 'Synthetic-fixture-password-123!';
const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5);
const realNow = Date.now;
Date.now = () => timestamp;
const store = new Store(filename, secret);
let model, peer;
let expectation, details;
try {
  const users = ['owner', 'editor', 'viewer'].map(role => {
    const created = store.createUser(`legacy.${role}`, password), id = `legacy-user-${role}`;
    store.db.prepare('UPDATE users SET id=? WHERE id=?').run(id, created.id);
    return { id, username: created.username, role };
  });
  function boardWithId(id, title) {
    const created = store.createBoard(users[0].id, title);
    // Normalize opaque generated IDs only; retain the baseline constructor's database/schema/snapshot.
    store.db.pragma('foreign_keys = OFF');
    store.db.transaction(() => {
      store.db.prepare('UPDATE boards SET id=? WHERE id=?').run(id, created.id);
      for (const table of ['members', 'documents', 'updates', 'assets']) store.db.prepare(`UPDATE ${table} SET board_id=? WHERE board_id=?`).run(id, created.id);
    })();
    store.db.pragma('foreign_keys = ON');
    return id;
  }
  const boardId = boardWithId('legacy-board-seven-types', 'Legacy Latin 日本語 board');
  const emptyBoardId = boardWithId('legacy-board-empty', 'Legacy empty board');
  for (const user of users.slice(1)) store.setMember(boardId, user.id, user.role);
  store.addAsset({ id: assetId, boardId, mimeType: 'image/png', size: png.length, storageKey });
  const doc = new Y.Doc(); Y.applyUpdate(doc, store.loadDocument(boardId)); doc.clientID = 101;
  model = new BoardDocument(doc);
  doc.on('update', update => store.appendUpdate(boardId, update));
  const rect = model.create('rect', { id: 'legacy-rect', x: 20, y: 30, w: 180, h: 100, style: { fill: '#dbeafe' } });
  const ellipse = model.create('ellipse', { id: 'legacy-ellipse', x: 320, y: 40, w: 150, h: 110, rotation: .15, style: { fill: '#dcfce7' } });
  model.create('sticky', { id: 'legacy-sticky', x: 25, y: 210, w: 210, h: 145, props: { text: 'Legacy note\n日本語とLatin', align: 'center', autoSize: false } });
  model.create('text', { id: 'legacy-text', x: 285, y: 235, style: { fontSize: 22, fontFamily: 'IBM Plex Mono' }, props: { text: 'Hello legacy!\nこんにちは世界', align: 'left', autoSize: true } });
  model.create('stroke', { id: 'legacy-stroke', props: { points: [35, 405, .2, 70, 380, .6, 115, 420, 1, 165, 390, .4], simplified: false }, style: { stroke: '#7c3aed', strokeWidth: 5 } });
  model.create('connector', { id: 'legacy-connector', props: { start: bindToElement(rect, 1, .5), end: bindToElement(ellipse, 0, .5), kind: 'curve' }, style: { stroke: '#b45309', strokeWidth: 3 } });
  model.create('image', { id: 'legacy-image', x: 390, y: 390, w: 64, h: 64, rotation: -.1, props: { assetId, naturalW: 1, naturalH: 1 } });
  model.update('legacy-rect', { x: 36 });
  model.undoManager.undo(); assert.equal(model.read('legacy-rect').x, 20);
  model.undoManager.redo(); assert.equal(model.read('legacy-rect').x, 36);
  model.create('rect', { id: 'legacy-deleted', x: 999, y: 999 }); model.delete('legacy-deleted');
  const peerDoc = new Y.Doc(); Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc)); peerDoc.clientID = 202;
  peer = new BoardDocument(peerDoc);
  peerDoc.on('update', update => Y.applyUpdate(doc, update, 'synthetic-peer'));
  peer.update('legacy-sticky', { rotation: -.05 });
  peer.updateStyle(['legacy-ellipse'], { stroke: '#166534' });
  assert.equal(model.readAll().length, 7);
  assert.equal(model.read('legacy-deleted'), undefined);
  const elements = model.readAll();
  const svg = documentToSvg(elements, { title: 'Legacy Latin 日本語 board', assetUrl: id => id === assetId ? `data:image/png;base64,${png.toString('base64')}` : undefined });
  const rawWriters = [...doc.share].filter(([name]) => name.startsWith('element-properties:')).map(([name, array]) => ({ name, records: array.toArray() }));
  assert.ok(rawWriters.every(writer => writer.records.some(record => record.key === '["$clock"]')));
  const emptyDoc = new Y.Doc(); Y.applyUpdate(emptyDoc, store.loadDocument(emptyBoardId));
  expectation = { boardId, metadata: doc.getMap('meta').toJSON(), elements, emptyBoard: { id: emptyBoardId, metadata: emptyDoc.getMap('meta').toJSON(), elements: [] } };
  emptyDoc.destroy();
  writeFileSync(join(output, 'schema2-pre-f1.expected.json'), canonical(expectation));
  writeFileSync(join(output, 'schema2-pre-f1.expected.svg'), svg + '\n');
  writeFileSync(join(output, 'schema2-pre-f1.raw-writers.json'), canonical(rawWriters));
  details = {
    baselineCommit: BASELINE, generationCommand: ['node', '--import', 'tsx', fileURLToPath(import.meta.url), baseline, output], sourceImports: { storeUrl, modelUrl }, sourceFiles: sources,
    dependencies: { yjs: JSON.parse(readFileSync(join(baseline, 'node_modules/yjs/package.json'), 'utf8')).version, sqlite: JSON.parse(readFileSync(join(baseline, 'packages/server/node_modules/better-sqlite3/package.json'), 'utf8')).version },
    syntheticOnly: true, syntheticCredentials: { password, sessionSecret: secret, users },
    boardId, emptyBoardId, asset: { id: assetId, boardId, storageKey, mimeType: 'image/png', size: png.length, sha256: hash(png) },
    userVersion: store.db.pragma('user_version', { simple: true }), schemaVersion: doc.getMap('meta').get('schemaVersion'),
    schema: store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all(),
    history: { writers: rawWriters.map(writer => writer.name), stateVector: [...Y.decodeStateVector(Y.encodeStateVector(doc))].sort((a, b) => a[0] - b[0]), updateLog: store.stats(boardId), operations: 'Seven creations; rect update/undo/redo; temporary rect creation/deletion; peer sticky rotation and ellipse stroke update. Legacy writer-array $clock records retained; pending update log not compacted.' },
    expectedProjection: 'schema2-pre-f1.expected.json', expectedSvg: 'schema2-pre-f1.expected.svg', rawWriters: 'schema2-pre-f1.raw-writers.json',
    reproducibility: 'Opaque user/board IDs are normalized. Password salts and metadata Yjs client IDs remain baseline-generated random values, so regenerations have equivalent logical contents rather than identical SQLite bytes.',
  };
  assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
  peer.destroy(); peer = undefined; model.destroy(); model = undefined;
  store.db.pragma('wal_checkpoint(TRUNCATE)');
} finally { peer?.destroy(); model?.destroy(); store.close(); Date.now = realNow; }
assert.ok(!existsSync(filename + '-wal') && !existsSync(filename + '-shm'), 'Fixture must not require WAL/SHM sidecars.');
// Reopen a disposable copy through the same baseline implementation, leaving the fixture immutable.
const verifyPath = join(output, '.schema2-pre-f1-verify.sqlite');
writeFileSync(verifyPath, readFileSync(filename));
const reopened = new Store(verifyPath, secret);
try {
  const verifyDoc = new Y.Doc(); Y.applyUpdate(verifyDoc, reopened.loadDocument(details.boardId)); verifyDoc.clientID = 303;
  const verifyModel = new BoardDocument(verifyDoc);
  assert.equal(canonical(verifyModel.readAll()), canonical(expectation.elements));
  assert.equal(documentToSvg(verifyModel.readAll(), { title: expectation.metadata.title, assetUrl: id => id === assetId ? `data:image/png;base64,${png.toString('base64')}` : undefined }) + '\n', readFileSync(join(output, 'schema2-pre-f1.expected.svg'), 'utf8'));
  for (const user of details.syntheticCredentials.users) { assert.ok(reopened.login(user.username, password)); assert.equal(reopened.role(details.boardId, user.id), user.role); }
  verifyModel.destroy();
  assert.equal(reopened.db.pragma('integrity_check', { simple: true }), 'ok');
} finally { reopened.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(verifyPath + suffix, { force: true }); }
details.artifacts = ['schema2-pre-f1.sqlite', 'schema2-pre-f1.expected.json', 'schema2-pre-f1.expected.svg', 'schema2-pre-f1.raw-writers.json', storageKey].map(path => ({ path, sha256: hash(readFileSync(join(output, path))) }));
details.verification = { baselineReopen: true, canonicalProjectionAndSvg: true, passwordsAndRoles: true, sqliteIntegrity: 'ok', noWalDependency: true };
writeFileSync(join(output, 'schema2-pre-f1.provenance.json'), canonical(details));
console.log(JSON.stringify({ filename, baseline: BASELINE, types: expectation.elements.map(element => element.type), updateLog: details.history.updateLog, verification: details.verification }));

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function syntheticPng() {
  const chunk = (name, data) => {
    const type = Buffer.from(name), header = Buffer.alloc(4), crc = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    let sum = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
      sum ^= byte;
      for (let bit = 0; bit < 8; bit++) sum = (sum >>> 1) ^ ((sum & 1) ? 0xedb88320 : 0);
    }
    crc.writeUInt32BE((sum ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, type, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 70, 130, 180, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function canonical(value) {
  const sorted = input => Array.isArray(input) ? input.map(sorted) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])])) : input;
  return JSON.stringify(sorted(value), null, 2) + '\n';
}
