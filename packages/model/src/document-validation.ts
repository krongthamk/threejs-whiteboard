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
      const records = [...winners].filter(([key]) => registerKey(key)?.[0] === id).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
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

type CachedRecord = { record?: WriterRecord; issues: BoardValidationIssue[]; occurrences: number; clock?: number };
type CachedWriter = { name: string; array: Y.Array<unknown>; records: Map<unknown, CachedRecord>; local: Map<string, WriterRecord>; rootIssues: BoardValidationIssue[]; dirty: boolean; deepDirty: boolean };
export interface BoardUpdateValidatorStats { fullScans: number; validatedRecords: number; projectedElements: number; cachedRecords: number; cachedElements: number }
export class IncompleteBoardUpdateError extends Error {
  constructor() { super('Board update is missing causal dependencies; retry the complete document state.'); this.name = 'IncompleteBoardUpdateError'; }
}

const validationIssue = (code: string, location: string, value: unknown, elementId?: string): BoardValidationIssue => ({
  code, location, ...(elementId ? { elementId } : {}), fingerprint: `${code}:${location}:${contentFingerprint(value)}`,
});

/** An isolated, disposable preflight replica; it never observes or writes to the live document. */
export class BoardUpdateValidator {
  private stage!: Y.Doc;
  private writers = new Map<string, CachedWriter>();
  private winners = new Map<string, StampedValue>();
  private elementKeys = new Map<string, Set<string>>();
  private elements = new Map<string, Element>();
  private projectionIssues = new Map<string, BoardValidationIssue>();
  private otherRootIssues = new Map<string, BoardValidationIssue[]>();
  private issueCounts = new Map<string, { issue: BoardValidationIssue; count: number }>();
  private metadataIssues: BoardValidationIssue[] = [];
  private metadataDirty = true;
  private bound = 0;
  private disposed = false;
  private counters = { fullScans: 0, validatedRecords: 0, projectedElements: 0 };

  constructor(private readonly liveDoc: Y.Doc) { this.rebuild(); }

  getStats(): BoardUpdateValidatorStats {
    return { ...this.counters, cachedRecords: [...this.writers.values()].reduce((sum, writer) => sum + [...writer.records.values()].reduce((count, record) => count + record.occurrences, 0), 0), cachedElements: this.elements.size };
  }

  /** Return the exact accepted Yjs delta, excluding already integrated deletion history. */
  validate(update: Uint8Array): Uint8Array {
    this.assertActive();
    const previous = new Map([...this.issueCounts].map(([fingerprint, value]) => [fingerprint, value.count]));
    const stage = this.stage, emitted: Uint8Array[] = [];
    const capture = (value: Uint8Array) => { emitted.push(value); };
    stage.on('update', capture);
    try {
      Y.applyUpdate(stage, update, 'validation');
      if (stage.store.pendingStructs || stage.store.pendingDs) throw new IncompleteBoardUpdateError();
      this.flush();
      for (const [fingerprint, { issue, count }] of this.issueCounts) if (count > (previous.get(fingerprint) ?? 0)) throw new Error(`Invalid whiteboard document: ${issue.code} at ${issue.location}`);
      return emitted.length === 1 ? emitted[0]! : emitted.length ? Y.mergeUpdates(emitted) : new Uint8Array([0, 0]);
    } catch (error) { this.rebuild(); throw error; }
    finally { stage.off('update', capture); }
  }

  /** Committed live updates become the historical baseline, including legacy repair operations. */
  syncLive(update?: Uint8Array): void {
    this.assertActive();
    try { Y.applyUpdate(this.stage, update ?? Y.encodeStateAsUpdate(this.liveDoc, Y.encodeStateVector(this.stage)), 'live'); this.flush(); }
    catch { this.rebuild(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stage.destroy(); this.clear();
  }

  private assertActive(): void { if (this.disposed) throw new Error('Board update validator is disposed'); }
  private clear(): void {
    this.writers.clear(); this.winners.clear(); this.elementKeys.clear(); this.elements.clear(); this.projectionIssues.clear(); this.otherRootIssues.clear(); this.issueCounts.clear(); this.metadataIssues = []; this.metadataDirty = true; this.bound = 0;
  }
  private rebuild(): void {
    this.stage?.destroy(); this.clear(); this.counters.fullScans++;
    this.stage = new Y.Doc(); Y.applyUpdate(this.stage, Y.encodeStateAsUpdate(this.liveDoc), 'initialization');
    this.stage.on('beforeObserverCalls', this.discover);
    this.discover(); this.flush();
  }

  private discover = (): void => {
    for (const name of this.stage.share.keys()) {
      if (name === 'meta' && !this.otherRootIssues.has('meta-observer')) {
        try { this.stage.getMap('meta').observeDeep(() => { this.metadataDirty = true; }); }
        catch { /* The metadata inspection below records the incompatible root. */ }
        this.otherRootIssues.set('meta-observer', []); this.metadataDirty = true;
      }
      if (!name.startsWith(WRITER_PREFIX) || this.writers.has(name) || this.otherRootIssues.has(name)) continue;
      try {
        const array = this.stage.getArray(name);
        const writer: CachedWriter = { name, array, records: new Map(), local: new Map(), rootIssues: [], dirty: true, deepDirty: false };
        this.writers.set(name, writer);
        array.observeDeep(events => { writer.dirty = true; if (events.some(event => event.target !== array)) writer.deepDirty = true; });
      } catch {
        const issues = [validationIssue('writer-root', name, this.stage.share.get(name)?.toJSON())];
        this.otherRootIssues.set(name, issues); this.adjust(issues, 1);
      }
    }
  };

  private adjust(issues: readonly BoardValidationIssue[], amount: number): void {
    for (const issue of issues) {
      const count = (this.issueCounts.get(issue.fingerprint)?.count ?? 0) + amount;
      if (count > 0) this.issueCounts.set(issue.fingerprint, { issue, count }); else this.issueCounts.delete(issue.fingerprint);
    }
  }

  private evaluate(value: unknown, name: string): Omit<CachedRecord, 'occurrences'> {
    this.counters.validatedRecords++;
    const actor = name.slice(WRITER_PREFIX.length), issues: BoardValidationIssue[] = [];
    const rawClock = plainRecord(value) && plainRecord(value.val) && plainRecord(value.val.stamp) ? value.val.stamp.clock : undefined;
    const clock = typeof rawClock === 'number' && Number.isSafeInteger(rawClock) ? rawClock : undefined;
    if (!validWriterRecord(value, actor, this.bound)) return { issues: [validationIssue('writer-record', name, value)], clock };
    const parts = registerKey(value.key)!;
    if (parts.length === 1 && (typeof value.val.value !== 'number' || value.val.value !== value.val.stamp.clock)) return { issues: [validationIssue('clock-record', `${name}/${value.key}`, value)], clock };
    if (parts[1] === '$base' && value.val.value !== null) {
      try {
        const base = value.val.value;
        if (!plainRecord(base) || typeof base.generation !== 'string' || !base.generation || !plainRecord(base.element) || base.element.id !== parts[0]) throw new Error('Invalid base');
        assertValidElement(base.element);
      } catch { issues.push(validationIssue('element-base', `${name}/${value.key}`, value, parts[0])); }
    }
    return { record: value, issues, clock };
  }

  private flush(): void {
    const previousBound = this.bound; this.bound = causalClockBound(this.stage);
    const touched = new Set<string>();
    // Only previously impossible clock records need reconsideration when the causal budget grows.
    for (const writer of this.writers.values()) {
      const causalChanged = [...writer.records.values()].some(value => value.clock !== undefined && (value.clock > previousBound && value.clock <= this.bound || !this.bound && previousBound));
      if (!writer.dirty && !causalChanged) continue;
      const keys = new Set<string>(), current = new Map<unknown, number>(), values = writer.array.toArray();
      for (const value of values) current.set(value, (current.get(value) ?? 0) + 1);
      for (const [value, cached] of writer.records) if (!current.has(value)) {
        this.adjust(cached.issues, -cached.occurrences); if (cached.record) keys.add(cached.record.key); writer.records.delete(value);
      }
      for (const [value, occurrences] of current) {
        const old = writer.records.get(value);
        const reevaluate = !old || writer.deepDirty || old.clock !== undefined && (old.clock > previousBound && old.clock <= this.bound || !this.bound && previousBound);
        const next = reevaluate ? { ...this.evaluate(value, writer.name), occurrences } : { ...old!, occurrences };
        if (!old || reevaluate || old.occurrences !== occurrences) {
          if (old) this.adjust(old.issues, -old.occurrences);
          this.adjust(next.issues, occurrences);
          if (old?.record) keys.add(old.record.key); if (next.record) keys.add(next.record.key);
        }
        writer.records.set(value, next);
      }
      this.adjust(writer.rootIssues, -1); writer.rootIssues = [];
      const mapValues = [...writer.array._map].filter(([_key, item]) => !item.deleted).map(([key, item]) => [key, item.content.getContent().at(-1)]);
      if (mapValues.length) writer.rootIssues.push(validationIssue('writer-root', writer.name, mapValues));
      this.adjust(writer.rootIssues, 1);
      for (const key of keys) writer.local.delete(key);
      for (const value of values) { const record = writer.records.get(value)!.record; if (record && keys.has(record.key)) writer.local.set(record.key, record); }
      for (const key of keys) {
        let winner: StampedValue | undefined;
        for (const candidate of this.writers.values()) {
          const value = candidate.local.get(key)?.val;
          if (value && (!winner || value.stamp.clock > winner.stamp.clock || value.stamp.clock === winner.stamp.clock && value.stamp.actor >= winner.stamp.actor)) winner = value;
        }
        if (winner) this.winners.set(key, winner); else this.winners.delete(key);
        const parts = registerKey(key)!;
        if (key !== CLOCK_KEY) {
          const id = parts[0]!; touched.add(id);
          let elementKeys = this.elementKeys.get(id);
          if (!elementKeys) { elementKeys = new Set(); this.elementKeys.set(id, elementKeys); }
          if (winner) elementKeys.add(key); else elementKeys.delete(key);
          if (!elementKeys.size) this.elementKeys.delete(id);
        }
      }
      writer.dirty = false; writer.deepDirty = false;
    }
    for (const id of touched) {
      const old = this.projectionIssues.get(id); if (old) { this.adjust([old], -1); this.projectionIssues.delete(id); }
      this.counters.projectedElements++;
      try { const element = projectedElement(id, key => this.winners.get(key)?.value); if (element) this.elements.set(id, element); else this.elements.delete(id); }
      catch {
        this.elements.delete(id);
        const records = [...(this.elementKeys.get(id) ?? [])].sort().map(key => [key, this.winners.get(key)!]);
        const issue = validationIssue('element-projection', `element/${id}`, records, id);
        this.projectionIssues.set(id, issue); this.adjust([issue], 1);
      }
    }
    if (this.metadataDirty || !this.bound || (!this.bound !== !previousBound)) this.inspectMetadata();
  }

  private inspectMetadata(): void {
    this.adjust(this.metadataIssues, -1); const issues: BoardValidationIssue[] = [];
    if (!this.bound && this.stage.store.clients.size) issues.push(validationIssue('causal-state', 'state-vector', [...Y.decodeStateVector(Y.encodeStateVector(this.stage))]));
    if (this.stage.share.has('meta')) {
      try {
        const meta = this.stage.getMap('meta'), version = meta.get('schemaVersion'), title = meta.get('title'), createdAt = meta.get('createdAt');
        const values: unknown[] = [];
        for (let item: Y.Item | null = meta._start; item; item = item.right) if (!item.deleted) values.push(...item.content.getContent());
        if (values.length) issues.push(validationIssue('metadata-root', 'meta', values));
        if (version !== undefined && version !== SCHEMA_VERSION) issues.push(validationIssue('schema-version', 'meta/schemaVersion', version));
        if (title !== undefined && typeof title !== 'string') issues.push(validationIssue('metadata', 'meta/title', title));
        if (createdAt !== undefined && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) issues.push(validationIssue('metadata', 'meta/createdAt', createdAt));
      } catch { issues.push(validationIssue('metadata-root', 'meta', this.stage.share.get('meta')?.toJSON())); }
    }
    this.metadataIssues = issues; this.adjust(issues, 1); this.metadataDirty = false;
  }
}
