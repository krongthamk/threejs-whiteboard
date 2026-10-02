import * as Y from 'yjs';
import { assertValidElement, compareElements } from './schema.js';
import { deriveElementGeometry } from './geometry.js';
import type { Element } from './types.js';

export const REGISTER_FIELDS = ['x', 'y', 'w', 'h', 'rotation', 'index', 'style', 'props'] as const;
export const WRITER_PREFIX = 'element-properties:';
export const CLOCK_KEY = JSON.stringify(['$clock']);
export const SCHEMA_VERSION = 2;
export type StampedValue = { stamp: { clock: number; actor: string }; value: unknown };
export type WriterRecord = { key: string; val: StampedValue };
export const plainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function registerKey(key: unknown): string[] | undefined {
  if (typeof key !== 'string') return;
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string' && part.length > 0) || JSON.stringify(parts) !== key) return;
    if (parts.length === 1 && parts[0] === '$clock' || parts.length === 2 && parts[1] === '$base' || parts.length === 3 && REGISTER_FIELDS.includes(parts[2])) return parts;
  } catch { /* Quarantine malformed legacy keys. */ }
}

/** Every honest Lamport increment emits a Yjs item; history survives deletion/compaction. */
export function causalClockBound(doc: Y.Doc): number {
  let bound = 0;
  for (const clock of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) {
    if (!Number.isSafeInteger(clock) || clock < 0 || !Number.isSafeInteger(bound + clock)) return 0;
    bound += clock;
  }
  return bound;
}

export function validWriterRecord(value: unknown, actor: string, clockBound = Number.MAX_SAFE_INTEGER): value is WriterRecord {
  if (!actor || !plainRecord(value) || !registerKey(value.key) || !plainRecord(value.val) || !plainRecord(value.val.stamp) || !Object.hasOwn(value.val, 'value')) return false;
  const stamp = value.val.stamp;
  return Number.isSafeInteger(stamp.clock) && (stamp.clock as number) >= 0 && (stamp.clock as number) <= clockBound && stamp.actor === actor;
}

export function projectedElement(id: string, get: (key: string) => unknown): Element | undefined {
  const base = get(JSON.stringify([id, '$base']));
  if (base === undefined || base === null) return;
  if (!plainRecord(base) || typeof base.generation !== 'string' || !base.generation || !plainRecord(base.element) || base.element.id !== id) throw new Error('Invalid element base');
  const element = structuredClone(base.element);
  for (const field of REGISTER_FIELDS) {
    const value = get(JSON.stringify([id, base.generation, field]));
    if (value !== undefined) element[field] = structuredClone(value);
  }
  assertValidElement(element);
  const derived = deriveElementGeometry(element);
  assertValidElement(derived);
  return derived;
}

export interface BoardValidationIssue { code: string; location: string; elementId?: string; fingerprint: string }
export interface BoardDocumentInspection {
  elements: Element[];
  invalidIds: ReadonlySet<string>;
  malformedRecords: number;
  issues: readonly BoardValidationIssue[];
  schemaVersion: unknown;
}

function contentFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) return { nonFinite: String(item) };
    if (item instanceof Y.AbstractType) return { yjsType: item.constructor.name, data: item.toJSON() };
    if (plainRecord(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  }) ?? String(value);
}

/** Read raw schema-2 registers without observers, initialization writes or duplicate cleanup. */
export function inspectBoardDocument(doc: Y.Doc): BoardDocumentInspection {
  const issues: BoardValidationIssue[] = [], winners = new Map<string, StampedValue>(), invalidIds = new Set<string>();
  const clockBound = causalClockBound(doc);
  let malformedRecords = 0;
  const issue = (code: string, location: string, value: unknown, elementId?: string) => {
    issues.push({ code, location, ...(elementId ? { elementId } : {}), fingerprint: `${code}:${location}:${contentFingerprint(value)}` });
  };
  if (!clockBound && doc.store.clients.size) issue('causal-state', 'state-vector', [...Y.decodeStateVector(Y.encodeStateVector(doc))]);
  let schemaVersion: unknown;
  if (doc.share.has('meta')) {
    try {
      const meta = doc.getMap('meta'); schemaVersion = meta.get('schemaVersion');
      // Network-created root types are generic until materialized. An array/XML
      // sequence in the metadata root must not disappear when read as a map.
      if (meta._start !== null) {
        const values: unknown[] = [];
        for (let item: Y.Item | null = meta._start; item; item = item.right) if (!item.deleted) values.push(...item.content.getContent());
        if (values.length) issue('metadata-root', 'meta', values);
      }
      if (schemaVersion !== undefined && schemaVersion !== SCHEMA_VERSION) issue('schema-version', 'meta/schemaVersion', schemaVersion);
      const title = meta.get('title'), createdAt = meta.get('createdAt');
      if (title !== undefined && typeof title !== 'string') issue('metadata', 'meta/title', title);
      if (createdAt !== undefined && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) issue('metadata', 'meta/createdAt', createdAt);
    } catch { issue('metadata-root', 'meta', doc.share.get('meta')?.toJSON()); }
  }
  for (const name of doc.share.keys()) {
    if (!name.startsWith(WRITER_PREFIX)) continue;
    const actor = name.slice(WRITER_PREFIX.length);
    let values: unknown[];
    try {
      const records = doc.getArray(name);
      if (records._map.size) {
        const values = [...records._map].filter(([_key, item]) => !item.deleted).map(([key, item]) => [key, item.content.getContent().at(-1)]);
        if (values.length) { malformedRecords++; issue('writer-root', name, values); }
      }
      values = records.toArray();
    }
    catch { malformedRecords++; issue('writer-root', name, doc.share.get(name)?.toJSON()); continue; }
    const local = new Map<string, WriterRecord>();
    for (const value of values) {
      if (!actor || !validWriterRecord(value, actor, clockBound)) {
        malformedRecords++; issue('writer-record', name, value); continue;
      }
      const parts = registerKey(value.key)!;
      if (parts.length === 1 && (typeof value.val.value !== 'number' || value.val.value !== value.val.stamp.clock)) {
        malformedRecords++; issue('clock-record', `${name}/${value.key}`, value); continue;
      }
      // Last physical record wins inside a writer, matching the live register facade.
      local.set(value.key, value);
      if (parts[1] === '$base' && value.val.value !== null) {
        try {
          const base = value.val.value;
          if (!plainRecord(base) || typeof base.generation !== 'string' || !base.generation || !plainRecord(base.element) || base.element.id !== parts[0]) throw new Error('Invalid base');
          assertValidElement(base.element);
        } catch { issue('element-base', `${name}/${value.key}`, value, parts[0]); }
      }
    }
    for (const { key, val } of local.values()) {
      const previous = winners.get(key);
      if (!previous || val.stamp.clock > previous.stamp.clock || val.stamp.clock === previous.stamp.clock && val.stamp.actor >= previous.stamp.actor) winners.set(key, val);
    }
  }
  const ids = new Set<string>();
  for (const [key, value] of winners) { const parts = registerKey(key)!; if (parts[1] === '$base' && value.value !== null) ids.add(parts[0]!); }
  const elements: Element[] = [];
  for (const id of ids) {
    try { const element = projectedElement(id, key => winners.get(key)?.value); if (element) elements.push(element); }
    catch {
      invalidIds.add(id);
      const records = [...winners].filter(([key]) => registerKey(key)?.[0] === id);
      issue('element-projection', `element/${id}`, records, id);
    }
  }
  return { elements: elements.sort(compareElements), invalidIds, malformedRecords, issues, schemaVersion };
}

/** Reject new poison while allowing unchanged historical junk and repairs. */
export function assertValidBoardDocument(doc: Y.Doc, previous?: BoardDocumentInspection): void {
  const allowed = new Map<string, number>();
  for (const issue of previous?.issues ?? []) allowed.set(issue.fingerprint, (allowed.get(issue.fingerprint) ?? 0) + 1);
  for (const issue of inspectBoardDocument(doc).issues) {
    const count = allowed.get(issue.fingerprint) ?? 0;
    if (!count) throw new Error(`Invalid whiteboard document: ${issue.code} at ${issue.location}`);
    allowed.set(issue.fingerprint, count - 1);
  }
}
