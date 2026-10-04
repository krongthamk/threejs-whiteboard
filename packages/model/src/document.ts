import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import { assertValidElement, compareElements, createElement } from './schema.js';
import { deriveElementGeometry, resolveBinding } from './geometry.js';
import { CLOCK_KEY, SCHEMA_VERSION, WRITER_PREFIX, REGISTER_FIELDS, causalClockBound, projectedElement, registerKey, validWriterRecord, type StampedValue, type WriterRecord } from './document-validation.js';
export { CLOCK_KEY, SCHEMA_VERSION, WRITER_PREFIX, type StampedValue, type WriterRecord } from './document-validation.js';
import type { Binding, Element, ElementInput, ElementOf, ElementPatch, ElementStyle, ElementType, Point } from './types.js';

/** Local origins are not transmitted; providers use their own origin for incoming updates. */
export const LOCAL_ORIGIN = Symbol('whiteboard.local');

const FIELDS = REGISTER_FIELDS;
type BaseRecord = { generation: string; element: Element };
const baseKey = (id: string): string => JSON.stringify([id, '$base']);
const fieldKey = (id: string, generation: string, field: string): string => JSON.stringify([id, generation, field]);

export interface WriterOptions {
  undo?: boolean;
  /** Provider-backed empty documents receive board metadata from persistence or the server. */
  initializeMetadata?: boolean;
}
export type DocumentChange = { ids: ReadonlySet<string>; transaction: Y.Transaction; invalidIds: ReadonlySet<string>; malformedRecords: number; schemaVersion: unknown };
interface Writer { records: Y.Array<WriterRecord>; kv: SafeWriterRegisters }
const compare = (a: StampedValue, b: StampedValue): number => a.stamp.clock - b.stamp.clock || (a.stamp.actor < b.stamp.actor ? -1 : a.stamp.actor > b.stamp.actor ? 1 : 0);

/** Same array wire format and last-record rule as YKeyValue, with guarded input. */
class SafeWriterRegisters {
  readonly map = new Map<string, WriterRecord>();
  malformedRecords = 0;
  private listeners = new Set<(changes: Map<string, unknown>, transaction: Y.Transaction) => void>();
  constructor(readonly records: Y.Array<WriterRecord>, private actor: string, private initializationTransaction?: Y.Transaction) { this.scan(); records.observe(this.observe); }
  private scan(): void {
    const values: unknown[] = this.records.toArray();
    const clockBound = causalClockBound(this.records.doc!);
    this.map.clear(); this.malformedRecords = 0;
    this.records.doc!.transact(() => {
      for (let i = values.length - 1; i >= 0; i--) {
        const value = values[i];
        if (!validWriterRecord(value, this.actor, clockBound)) { this.malformedRecords++; continue; }
        if (value.key === CLOCK_KEY && value.val.value !== value.val.stamp.clock) { this.malformedRecords++; continue; }
        if (this.map.has(value.key)) this.records.delete(i);
        else this.map.set(value.key, value);
      }
    });
  }
  private observe = (_event: Y.YArrayEvent<WriterRecord>, transaction: Y.Transaction): void => {
    // A writer discovered in beforeObserverCalls is already scanned through
    // this transaction; Yjs will still invoke its freshly attached observer.
    if (transaction === this.initializationTransaction) { this.initializationTransaction = undefined; return; }
    const changes = new Map<string, unknown>();
    const clockBound = causalClockBound(this.records.doc!);
    const acceptable = (value: unknown): value is WriterRecord => validWriterRecord(value, this.actor, clockBound) && (value.key !== CLOCK_KEY || value.val.value === value.val.stamp.clock);
    for (const item of _event.changes.deleted) for (const value of item.content.getContent()) {
      if (!acceptable(value)) { this.malformedRecords--; continue; }
      if (this.map.get(value.key) === value) { this.map.delete(value.key); changes.set(value.key, true); }
    }
    const added = new Map<string, WriterRecord>();
    for (const item of _event.changes.added) for (const value of item.content.getContent()) {
      if (acceptable(value)) added.set(value.key, value);
      else this.malformedRecords++;
    }
    const remove = new Set<string>(), values: unknown[] = this.records.toArray();
    this.records.doc!.transact(() => {
      for (let i = values.length - 1; i >= 0 && (added.size || remove.size); i--) {
        const value = values[i];
        if (!acceptable(value)) continue;
        if (remove.has(value.key)) { remove.delete(value.key); this.records.delete(i); }
        else if (added.get(value.key) === value) {
          if (this.map.has(value.key)) remove.add(value.key);
          changes.set(value.key, true); added.delete(value.key); this.map.set(value.key, value);
        } else if (added.has(value.key)) { remove.add(value.key); added.delete(value.key); }
      }
    });
    for (const listener of this.listeners) listener(changes, transaction);
  };
  get(key: string): StampedValue | undefined { return this.map.get(key)?.val; }
  set(key: string, val: StampedValue): void {
    this.records.doc!.transact(() => {
      const values: unknown[] = this.records.toArray();
      for (let i = values.length - 1; i >= 0; i--) {
        const value = values[i];
        if (value && typeof value === 'object' && 'key' in value && value.key === key) this.records.delete(i);
      }
      this.records.push([{ key, val }]);
    });
  }
  on(_event: 'change', listener: (changes: Map<string, unknown>, transaction: Y.Transaction) => void): void { this.listeners.add(listener); }
  destroy(): void { this.records.unobserve(this.observe); this.listeners.clear(); }
}

/** Schema 2: writer-owned Yjs registers with coherent values, native local undo, and offline merge. */
export class BoardDocument {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly actor: string;
  readonly undoManager: Y.UndoManager;
  readonly writers = new Map<string, Writer>();
  readonly own: Writer;
  readonly invalidIds = new Set<string>();
  get malformedRecords(): number { return this.malformedRoots.size + [...this.writers.values()].reduce((count, writer) => count + writer.kv.malformedRecords, 0); }
  get schemaVersion(): unknown { return this.meta.get('schemaVersion'); }
  private malformedRoots = new Set<string>();
  private diagnosticTransactions = new Set<Y.Transaction>();
  private winners = new Map<string, StampedValue>();
  private candidates = new Map<string, Map<string, StampedValue>>();
  private activeIds = new Set<string>();
  private listeners = new Set<(change: DocumentChange) => void>();
  private changes = new Map<Y.Transaction, Set<string>>();
  private indices = new Map<string, string>();
  private connectorTargets = new Map<string, readonly string[]>();
  private connectorDependents = new Map<string, Set<string>>();
  private maxIndex: string | null = null;
  private maxIndexDirty = true;
  private pending = new Map<string, StampedValue>();
  private maxClock = 0;
  private depth = 0;
  private discovering = false;

  constructor(doc = new Y.Doc(), options: WriterOptions = {}) {
    this.doc = doc; this.actor = String(doc.clientID);
    this.meta = doc.getMap('meta');
    const version = this.meta.get('schemaVersion');
    if (version === undefined && options.initializeMetadata !== false) doc.transact(() => {
      this.meta.set('schemaVersion', SCHEMA_VERSION);
      this.meta.set('title', 'Untitled board');
      this.meta.set('createdAt', Date.now());
    }, 'initialization');
    doc.getArray<WriterRecord>(WRITER_PREFIX + this.actor);
    this.discover();
    for (const id of this.activeIds) this.read(id);
    this.own = this.writers.get(this.actor)!;
    this.undoManager = new Y.UndoManager(this.own.records, {
      trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0,
      deleteFilter: item => !item.content.getContent().some(value => value && typeof value === 'object' && (value as WriterRecord).key === CLOCK_KEY),
    });
    const undo = this.undoManager.undo.bind(this.undoManager), redo = this.undoManager.redo.bind(this.undoManager);
    this.undoManager.undo = () => { this.assertSchemaVersion(); this.assertWriterIdentity(); return undo(); };
    this.undoManager.redo = () => { this.assertSchemaVersion(); this.assertWriterIdentity(); return redo(); };
    if (options.undo === false) this.undoManager.destroy();
    // Yjs 13.6.33 can coalesce a field and clock into one ContentAny Item. The public
    // deleteFilter must see the clock alone, or refusing it would refuse undoing the field too.
    // These exported low-level split helpers are pinned and regression-tested upgrade dependencies.
    doc.on('beforeTransaction', transaction => {
      if (transaction.origin !== this.undoManager) return;
      const index = this.own.records.toArray().findIndex(record => record.key === CLOCK_KEY);
      if (index < 0) return;
      const item = Y.createRelativePositionFromTypeIndex(this.own.records, index).item;
      if (item) { Y.getItemCleanStart(transaction, item); Y.getItemCleanEnd(transaction, this.doc.store, item); }
    });
    doc.on('beforeObserverCalls', this.discover);
    this.meta.observe(event => { this.diagnosticTransactions.add(event.transaction); });
    doc.on('afterTransaction', transaction => {
      this.pending.clear();
      const ids = this.changes.get(transaction);
      this.changes.delete(transaction);
      for (const id of ids ?? []) this.read(id);
      const diagnosticsChanged = this.diagnosticTransactions.delete(transaction);
      if (ids?.size || diagnosticsChanged) for (const listener of this.listeners) listener({ ids: ids ?? new Set(), transaction, invalidIds: new Set(this.invalidIds), malformedRecords: this.malformedRecords, schemaVersion: this.schemaVersion });
    });
  }

  private assertWriterIdentity(): void {
    if (String(this.doc.clientID) !== this.actor) throw new Error('Writer identity changed after a Yjs client-ID collision; reload the board before editing.');
  }

  private assertSchemaVersion(): void {
    const version = this.meta.get('schemaVersion');
    if (version !== undefined && version !== SCHEMA_VERSION) throw new Error(`Unsupported board schema ${String(version)}; expected ${SCHEMA_VERSION}`);
  }

  private discover = (transaction?: Y.Transaction): void => {
    if (this.discovering) return;
    this.discovering = true;
    try {
      for (const name of this.doc.share.keys()) {
        if (!name.startsWith(WRITER_PREFIX)) continue;
        const actor = name.slice(WRITER_PREFIX.length);
        if (this.writers.has(actor)) continue;
        let records: Y.Array<WriterRecord>;
        try { records = this.doc.getArray<WriterRecord>(name); if (records._map.size) this.malformedRoots.add(name); }
        catch { this.malformedRoots.add(name); if (transaction) this.diagnosticTransactions.add(transaction); continue; }
        const kv = new SafeWriterRegisters(records, actor, transaction);
        this.writers.set(actor, { records, kv });
        if (transaction) this.diagnosticTransactions.add(transaction);
        for (const key of kv.map.keys()) this.refresh(key, actor, kv.get(key), transaction);
        kv.on('change', (changes: Map<string, unknown>, transaction: Y.Transaction) => {
          for (const key of changes.keys()) this.refresh(key, actor, kv.get(key), transaction);
          this.diagnosticTransactions.add(transaction);
        });
      }
    } finally { this.discovering = false; }
  };

  private refresh(key: string, actor: string, value: StampedValue | undefined, transaction?: Y.Transaction): void {
    const parts = registerKey(key);
    if (!parts || value && !validWriterRecord({ key, val: value }, actor)) return;
    let candidates = this.candidates.get(key);
    if (!candidates) { candidates = new Map(); this.candidates.set(key, candidates); }
    const oldValue = candidates.get(actor);
    if (value) { candidates.set(actor, value); this.maxClock = Math.max(this.maxClock, value.stamp.clock); }
    else candidates.delete(actor);
    const previous = this.winners.get(key);
    let winner = previous;
    if (value && (!winner || compare(value, winner) >= 0)) winner = value;
    else if (previous === oldValue) {
      winner = undefined;
      for (const candidate of candidates.values()) if (!winner || compare(candidate, winner) > 0) winner = candidate;
    }
    if (winner) this.winners.set(key, winner); else this.winners.delete(key);
    if (candidates.size === 0) this.candidates.delete(key);
    if (previous === winner || key === CLOCK_KEY) return;
    const [id, field] = parts;
    if (!id) return;
    if (field === '$base') {
      if (winner && winner.value !== null && winner.value !== undefined) this.activeIds.add(id); else this.activeIds.delete(id);
    }
    if (transaction) {
      let changed = this.changes.get(transaction);
      if (!changed) { changed = new Set(); this.changes.set(transaction, changed); }
      changed.add(id);
    }
  }

  private get(key: string): unknown { return (this.pending.get(key) ?? this.winners.get(key))?.value; }
  /** Maximum valid projected index, maintained as changed IDs are projected. */
  highestIndex(): string | null {
    if (this.maxIndexDirty) {
      this.maxIndex = null;
      for (const index of this.indices.values()) if (this.maxIndex === null || index > this.maxIndex) this.maxIndex = index;
      this.maxIndexDirty = false;
    }
    return this.maxIndex;
  }
  nextIndex(): string { return generateKeyBetween(this.highestIndex(), null); }
  private cacheIndex(id: string, index: string | undefined): void {
    const previous = this.indices.get(id);
    if (previous === index) return;
    if (index === undefined) this.indices.delete(id); else this.indices.set(id, index);
    if (previous === this.maxIndex) this.maxIndexDirty = true;
    if (index !== undefined && (this.maxIndex === null || index > this.maxIndex)) this.maxIndex = index;
  }
  private cacheConnectorDependencies(id: string, element: Element | undefined): void {
    const targets = element?.type === 'connector'
      ? [...new Set([element.props.start, element.props.end].flatMap(binding => 'elementId' in binding ? [binding.elementId] : []))] : [];
    const previous = this.connectorTargets.get(id) ?? [];
    if (previous.length === targets.length && previous.every((target, i) => target === targets[i])) return;
    for (const target of previous) {
      const dependents = this.connectorDependents.get(target); dependents?.delete(id);
      if (!dependents?.size) this.connectorDependents.delete(target);
    }
    if (!targets.length) this.connectorTargets.delete(id); else this.connectorTargets.set(id, targets);
    for (const target of targets) {
      const dependents = this.connectorDependents.get(target) ?? new Set<string>();
      dependents.add(id); this.connectorDependents.set(target, dependents);
    }
  }
  private set(key: string, value: unknown): void {
    const parts = JSON.parse(key) as string[];
    const stamped: StampedValue = { stamp: { clock: ++this.maxClock, actor: this.actor }, value };
    this.own.kv.set(key, stamped); this.pending.set(key, stamped);
    if (parts[2] === 'index' || parts[2] === 'props' || parts[1] === '$base') this.read(parts[0]!);
  }
  private writeClock(): void {
    const existing = this.own.kv.get(CLOCK_KEY);
    if (existing && existing.stamp.clock >= this.maxClock) return;
    this.own.kv.set(CLOCK_KEY, { stamp: { clock: this.maxClock, actor: this.actor }, value: this.maxClock });
  }

  transact<T>(fn: () => T): T {
    this.assertSchemaVersion();
    this.assertWriterIdentity();
    const outer = this.depth++ === 0;
    try {
      const result = this.doc.transact(() => {
        const value = fn();
        if (outer) this.writeClock();
        return value;
      }, LOCAL_ORIGIN);
      return result;
    } finally { this.depth--; }
  }

  base(id: string): BaseRecord | undefined { return structuredClone(this.get(baseKey(id)) ?? undefined) as BaseRecord | undefined; }
  add(element: Element): Element {
    assertValidElement(element);
    element = deriveElementGeometry(element);
    assertValidElement(element);
    if (this.base(element.id)) throw new Error(`Element already exists: ${element.id}`);
    const generation = `${this.actor}:${Y.getState(this.doc.store, this.doc.clientID)}`;
    this.transact(() => this.set(baseKey(element.id), { generation, element: structuredClone(element) }));
    if (this.maxIndex === null || element.index > this.maxIndex) this.maxIndex = element.index;
    return structuredClone(element);
  }
  create<T extends ElementType>(type: T, input: ElementInput<T> = {}): ElementOf<T> {
    const highest = this.highestIndex();
    const index = input.index ?? generateKeyBetween(highest, null);
    const element = this.add(createElement(type, { ...input, index }) as Element) as ElementOf<T>;
    // A creation can only extend the maximum. This also handles repeated creations inside one gesture.
    if (this.maxIndex === null || index > this.maxIndex) this.maxIndex = index;
    this.maxIndexDirty = false;
    return element;
  }
  read(id: string): Element | undefined {
    try {
      const element = projectedElement(id, key => this.get(key));
      this.cacheIndex(id, element?.index); this.cacheConnectorDependencies(id, element);
      this.invalidIds.delete(id); return element;
    } catch { this.cacheIndex(id, undefined); this.cacheConnectorDependencies(id, undefined); this.invalidIds.add(id); return undefined; }
  }
  readAll(): Element[] {
    const ids = new Set(this.activeIds);
    for (const key of this.pending.keys()) { const parts = JSON.parse(key) as string[]; if (parts[1] === '$base') ids.add(parts[0]!); }
    return [...ids].flatMap(id => {
      const element = this.read(id);
      return element ? [element] : [];
    }).sort(compareElements);
  }
  private preparePatch(id: string, patch: ElementPatch): { id: string; generation: string; patch: ElementPatch } | undefined {
    const element = this.read(id), base = this.base(id); if (!element || !base) return undefined;
    const prepared = structuredClone(patch);
    for (const key of Object.keys(prepared)) if (!FIELDS.includes(key as typeof FIELDS[number])) throw new Error(`Immutable or unknown element field: ${key}`);
    const merged = { ...element, ...prepared };
    assertValidElement(merged);
    assertValidElement(deriveElementGeometry(merged));
    return { id, generation: base.generation, patch: prepared };
  }
  update(id: string, patch: ElementPatch): boolean {
    const prepared = this.preparePatch(id, patch); if (!prepared) return false;
    this.transact(() => { for (const [key, value] of Object.entries(prepared.patch)) this.set(fieldKey(id, prepared.generation, key), value); });
    return true;
  }
  updateMany(updates: readonly { id: string; patch: ElementPatch }[]): void {
    // Multiple updates for one ID replace whole fields in order, just as the
    // register writes do. Validate their combined state before starting any writes.
    const patches = new Map<string, ElementPatch>();
    for (const { id, patch } of updates) patches.set(id, { ...patches.get(id), ...patch });
    const prepared = [...patches].map(([id, patch]) => this.preparePatch(id, patch)).filter(value => value !== undefined);
    this.transact(() => { for (const update of prepared) for (const [key, value] of Object.entries(update.patch)) this.set(fieldKey(update.id, update.generation, key), value); });
  }
  updateStyle(ids: readonly string[], patch: Partial<ElementStyle>): void {
    this.updateMany(ids.flatMap(id => { const element = this.read(id); return element ? [{ id, patch: { style: { ...element.style, ...patch } } }] : []; }));
  }
  move(ids: readonly string[], delta: Point): void {
    const selected = new Set(ids), updates: { id: string; patch: ElementPatch }[] = [];
    let elements: Map<string, Element> | undefined;
    for (const id of ids) {
      const element = this.read(id); if (!element) continue;
      if (element.type === 'stroke') updates.push({ id, patch: { props: { ...element.props, points: element.props.points.map((n, i) => i % 3 === 0 ? n + delta.x : i % 3 === 1 ? n + delta.y : n) } } });
      else if (element.type === 'connector') {
        const moveBinding = (binding: Binding): Binding => {
          if ('elementId' in binding && selected.has(binding.elementId)) return binding;
          elements ??= new Map();
          if ('elementId' in binding && !elements.has(binding.elementId)) {
            const target = this.read(binding.elementId); if (target) elements.set(target.id, target);
          }
          const p = resolveBinding(binding, elements); return { x: p.x + delta.x, y: p.y + delta.y };
        };
        updates.push({ id, patch: { props: { ...element.props, start: moveBinding(element.props.start), end: moveBinding(element.props.end) } } });
      } else updates.push({ id, patch: { x: element.x + delta.x, y: element.y + delta.y } });
    }
    this.updateMany(updates);
  }
  delete(ids: string | readonly string[]): void {
    const deleted = new Set(typeof ids === 'string' ? [ids] : ids), elements = new Map<string, Element>(), dependents = new Set<string>();
    for (const id of deleted) {
      const bound = this.connectorDependents.get(id);
      if (!bound?.size) continue;
      const target = this.read(id); if (target) elements.set(id, target);
      for (const connectorId of bound) if (!deleted.has(connectorId)) dependents.add(connectorId);
    }
    const updates: { id: string; patch: ElementPatch }[] = [];
    for (const id of dependents) {
      const element = this.read(id); if (!element) continue;
        if (element.type !== 'connector' || deleted.has(element.id)) continue;
        const detach = (binding: Binding): Binding => 'elementId' in binding && deleted.has(binding.elementId) ? resolveBinding(binding, elements) : binding;
        const start = detach(element.props.start), end = detach(element.props.end);
        if (start !== element.props.start || end !== element.props.end) updates.push({ id: element.id, patch: { props: { ...element.props, start, end } } });
    }
    const prepared = updates.map(({ id, patch }) => this.preparePatch(id, patch)).filter(value => value !== undefined);
    this.transact(() => {
      for (const update of prepared) for (const [key, value] of Object.entries(update.patch)) this.set(fieldKey(update.id, update.generation, key), value);
      for (const id of deleted) if (this.get(baseKey(id)) !== undefined) this.set(baseKey(id), null);
    });
  }
  duplicate(ids: readonly string[], delta: Point = { x: 24, y: 24 }): string[] {
    const sources = ids.flatMap(id => { const element = this.read(id); return element ? [element] : []; });
    const idMap = new Map(sources.map(element => [element.id, nanoid()]));
    let index = this.highestIndex();
    const copies = sources.map(source => {
      index = generateKeyBetween(index, null);
      let copy = { ...source, id: idMap.get(source.id)!, index } as Element;
      if (copy.type === 'connector') {
        const remap = (binding: Binding): Binding => {
          if (!('elementId' in binding)) return { x: binding.x + delta.x, y: binding.y + delta.y };
          const elementId = idMap.get(binding.elementId);
          return elementId ? { ...binding, elementId, fallback: { x: binding.fallback.x + delta.x, y: binding.fallback.y + delta.y } } : binding;
        };
        copy = { ...copy, props: { ...copy.props, start: remap(copy.props.start), end: remap(copy.props.end) } };
      } else if (copy.type === 'stroke') copy = { ...copy, props: { ...copy.props, points: copy.props.points.map((n, i) => i % 3 === 0 ? n + delta.x : i % 3 === 1 ? n + delta.y : n) } };
      else copy = { ...copy, x: copy.x + delta.x, y: copy.y + delta.y };
      assertValidElement(copy); return copy;
    });
    this.transact(() => { for (const copy of copies) this.add(copy); });
    return copies.map(copy => copy.id);
  }
  reorder(id: string, direction: 'forward' | 'backward' | 'front' | 'back'): void {
    const elements = this.readAll(), i = elements.findIndex(element => element.id === id);
    if (i < 0) return;
    const remaining = elements.filter(element => element.id !== id);
    let insertion = direction === 'front' ? remaining.length : direction === 'back' ? 0 : direction === 'forward' ? Math.min(i + 1, remaining.length) : Math.max(i - 1, 0);
    if (direction === 'forward' || direction === 'front') while (insertion < remaining.length && remaining[insertion - 1]?.index === remaining[insertion]?.index) insertion++;
    else while (insertion > 0 && remaining[insertion - 1]?.index === remaining[insertion]?.index) insertion--;
    this.update(id, { index: generateKeyBetween(remaining[insertion - 1]?.index ?? null, remaining[insertion]?.index ?? null) });
  }
  subscribe(listener: (change: DocumentChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  destroy(): void { this.listeners.clear(); this.undoManager.destroy(); this.doc.off('beforeObserverCalls', this.discover); for (const writer of this.writers.values()) writer.kv.destroy(); this.doc.destroy(); }
}
