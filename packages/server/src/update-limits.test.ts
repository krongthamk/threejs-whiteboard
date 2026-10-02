import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { checkUpdateResources, UpdateResourceError } from './update-limits.js';
import { BoardUpdateValidator, IncompleteBoardUpdateError, WRITER_PREFIX } from '../../model/src/document-validation.js';
import { createElement } from '../../model/src/schema.js';

test('the resource walk accepts v1 shared types, unicode, binary, embeds and formats', () => {
  const source = new Y.Doc(), live = new Y.Doc();
  source.transact(() => {
    source.getMap('custom').set('values', [undefined, null, true, false, -700, 1.5, 2n, new Uint8Array([1, 2])]);
    const text = source.getText('text'); text.insert(0, 'ภาษาไทย😀'); text.format(0, 2, { bold: true }); text.insertEmbed(1, { image: 'asset' });
    source.getArray('array').push([new Y.Map(), new Y.Array(), new Y.Text(), new Y.XmlElement('p'), new Y.XmlText(), new Y.XmlFragment(), new Y.XmlHook('hook')]);
  });
  const update = Y.encodeStateAsUpdate(source);
  expect(checkUpdateResources(update, live)).toBe(true); Y.applyUpdate(live, update);
  expect(checkUpdateResources(update, live)).toBe(false);
  source.destroy(); live.destroy();
});

test('delete-only packets, compacted GC and honest offline histories retain their clocks', () => {
  const source = new Y.Doc(), live = new Y.Doc(), offline = new Y.Doc();
  source.getArray('history').push(['base', 'erase']);
  const initial = Y.encodeStateAsUpdate(source); Y.applyUpdate(live, initial); Y.applyUpdate(offline, initial);
  const vector = Y.encodeStateVector(source); source.getArray('history').delete(1, 1);
  const deletion = Y.encodeStateAsUpdate(source, vector);
  expect(checkUpdateResources(deletion, live)).toBe(true); Y.applyUpdate(live, deletion);
  expect(checkUpdateResources(deletion, live)).toBe(false);
  offline.getArray('history').push(['offline']);
  const retry = Y.encodeStateAsUpdate(offline, Y.encodeStateVector(live));
  expect(checkUpdateResources(retry, live)).toBe(true); Y.applyUpdate(live, retry);
  expect(checkUpdateResources(Y.encodeStateAsUpdate(source), live)).toBe(false);
  expect(live.getArray('history').toArray()).toEqual(['base', 'offline']);
  const nested = new Y.Map(); nested.set('child', new Y.Text('collected'));
  source.getArray('garbage').push([nested]); source.getArray('garbage').delete(0);
  const compacted = Y.encodeStateAsUpdate(source);
  expect(Y.decodeUpdate(compacted).structs.some(struct => struct instanceof Y.GC)).toBe(true);
  expect(() => checkUpdateResources(compacted, live)).not.toThrow(); Y.applyUpdate(live, compacted);
  source.destroy(); live.destroy(); offline.destroy();
});

test('a full 5,000-stroke offline retry fits the structural defaults and a known replay is free of new growth', () => {
  const source = new Y.Doc(), live = new Y.Doc(), actor = String(source.clientID);
  source.getArray(WRITER_PREFIX + actor).push(Array.from({ length: 5000 }, (_, index) => ({ key: JSON.stringify([`stroke-${index}`, '$base']), val: { stamp: { clock: index + 1, actor }, value: { generation: `${actor}:0`, element: createElement('stroke', { id: `stroke-${index}`, props: { points: [index, 0, .5], simplified: false } }) } } })));
  const full = Y.encodeStateAsUpdate(source); expect(full.length).toBeLessThan(4 * 1024 * 1024);
  expect(checkUpdateResources(full, live)).toBe(true); Y.applyUpdate(live, full);
  expect(checkUpdateResources(full, live)).toBe(false);
  source.destroy(); live.destroy();
});

test('bounded missing prefixes reach the isolated incomplete-update guard and full retry converges', () => {
  const source = new Y.Doc(), live = new Y.Doc();
  source.getMap('custom').set('prefix', 1); const prefixVector = Y.encodeStateVector(source);
  source.getMap('custom').set('suffix', 2); const suffix = Y.encodeStateAsUpdate(source, prefixVector);
  const validator = new BoardUpdateValidator(live);
  expect(checkUpdateResources(suffix, live)).toBe(true);
  expect(() => validator.validate(suffix)).toThrow(IncompleteBoardUpdateError);
  expect(live.store.pendingStructs).toBeNull();
  const full = Y.encodeStateAsUpdate(source); expect(checkUpdateResources(full, live)).toBe(true);
  validator.validate(full); Y.applyUpdate(live, full); validator.syncLive(full);
  expect(live.getMap('custom').toJSON()).toEqual({ prefix: 1, suffix: 2 });
  validator.dispose(); source.destroy(); live.destroy();
});

test('compressed GC growth, unsafe ranges, malformed bytes and nested value bombs are bounded before apply', () => {
  const live = new Y.Doc(), hostile = new Y.Doc();
  hostile.transact(transaction => new Y.GC(Y.createID(777, 0), Number.MAX_SAFE_INTEGER - 10).integrate(transaction, 0));
  const packet = Y.encodeStateAsUpdate(hostile); expect(packet.byteLength).toBeLessThan(50);
  expect(() => checkUpdateResources(packet, live)).toThrow('Unbounded logical clock growth');
  expect(() => checkUpdateResources(packet, live, Number.MAX_SAFE_INTEGER)).not.toThrow();
  expect(() => checkUpdateResources(packet.subarray(0, packet.length - 1), live)).toThrow(UpdateResourceError);
  expect(() => checkUpdateResources(new Uint8Array([0, 0, 0]), live)).toThrow('Trailing');
  const nested = new Y.Doc(); let value: unknown = 'leaf'; for (let i = 0; i < 34; i++) value = [value];
  nested.getMap('custom').set('deep', value);
  expect(() => checkUpdateResources(Y.encodeStateAsUpdate(nested), live)).toThrow('nested levels');
  const embed = new Y.Doc(); embed.getText('embed').insertEmbed(0, value as object);
  expect(() => checkUpdateResources(Y.encodeStateAsUpdate(embed), live)).toThrow('nested levels');
  expect(live.store.clients.size).toBe(0);
  live.destroy(); hostile.destroy(); nested.destroy(); embed.destroy();
});


test('extreme origin clocks are invalid while bounded missing origin prefixes remain retryable', () => {
  const packet = (clock: number) => {
    const bytes: number[] = []; const uint = (value: number) => { while (value >= 128) { bytes.push((value % 128) | 128); value = Math.floor(value / 128); } bytes.push(value); };
    uint(1); uint(1); uint(123); uint(0); bytes.push(136); uint(999); uint(clock); uint(1); bytes.push(125, 1); uint(0);
    return Uint8Array.from(bytes);
  };
  const live = new Y.Doc(), validator = new BoardUpdateValidator(live);
  expect(() => checkUpdateResources(packet(Number.MAX_SAFE_INTEGER), live)).toThrow('Unbounded struct reference');
  const honestMissing = packet(10); expect(checkUpdateResources(honestMissing, live)).toBe(true);
  expect(() => validator.validate(honestMissing)).toThrow(IncompleteBoardUpdateError);
  expect(live.store.pendingStructs).toBeNull(); validator.dispose(); live.destroy();
});

test('bounded future deletes and merged skip gaps reach staged incomplete recovery', () => {
  const live = new Y.Doc(), source = new Y.Doc(), validator = new BoardUpdateValidator(live), updates: Uint8Array[] = [];
  source.on('update', update => updates.push(update));
  source.getMap('gap').set('a', 1); source.getMap('gap').set('b', 2); source.getMap('gap').set('c', 3);
  const gap = Y.mergeUpdates([updates[0]!, updates[2]!]);
  expect(Y.decodeUpdate(gap).structs.some(struct => struct instanceof Y.Skip)).toBe(true);
  expect(() => checkUpdateResources(gap, live)).not.toThrow();
  expect(() => validator.validate(gap)).toThrow(IncompleteBoardUpdateError);
  const futureDelete = new Uint8Array([0, 1, 123, 1, 0, 10]);
  expect(() => checkUpdateResources(futureDelete, live)).not.toThrow();
  expect(() => validator.validate(futureDelete)).toThrow(IncompleteBoardUpdateError);
  expect(live.store.pendingDs).toBeNull();
  const full = Y.encodeStateAsUpdate(source); validator.validate(full); Y.applyUpdate(live, full); validator.syncLive(full);
  expect(live.getMap('gap').toJSON()).toEqual({ a: 1, b: 2, c: 3 });
  validator.dispose(); live.destroy(); source.destroy();
});
