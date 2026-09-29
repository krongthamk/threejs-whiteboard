import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { assertValidElement, compareElements, createElement, deriveElementGeometry, LOCAL_ORIGIN, resolveBinding,
  type Binding, type Element, type ElementInput, type ElementOf, type ElementPatch, type ElementStyle, type ElementType, type Point } from '../../packages/model/src/index.js';
import { baseKey, fieldKey, FIELDS, type BaseRecord } from './model.js';

export const WRITER_PREFIX = 'element-properties:';
export const CLOCK_KEY = JSON.stringify(['$clock']);
export const CLOCK_ORIGIN = Symbol('writer-clock');
export type StampedValue = { stamp: { clock: number; actor: string }; value: unknown };
export type WriterRecord = { key: string; val: StampedValue };
export interface WriterOptions { undo?: boolean; clockMode?: 'same-transaction' | 'separate-untracked' }
interface Writer { records: Y.Array<WriterRecord>; kv: YKeyValue<StampedValue> }
const compare = (a: StampedValue, b: StampedValue): number => a.stamp.clock - b.stamp.clock || (a.stamp.actor < b.stamp.actor ? -1 : a.stamp.actor > b.stamp.actor ? 1 : 0);

/** Experimental writer-owned registers; no production schema or reset is involved. */
export class WriterBoardDocument {
  readonly doc: Y.Doc;
  readonly actor: string;
  readonly undoManager: Y.UndoManager;
  readonly writers = new Map<string, Writer>();
  readonly own: Writer;
  private winners = new Map<string, StampedValue>();
  private pending = new Map<string, StampedValue>();
  private maxClock = 0;
  private depth = 0;
  private clockMode: 'same-transaction' | 'separate-untracked';
  private discovering = false;

  constructor(doc = new Y.Doc(), options: WriterOptions = {}) {
    this.doc = doc; this.actor = String(doc.clientID); this.clockMode = options.clockMode ?? 'same-transaction';
    doc.getArray<WriterRecord>(WRITER_PREFIX + this.actor);
    this.discover(); this.own = this.writers.get(this.actor)!;
    this.undoManager = new Y.UndoManager(this.own.records, {
      trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0,
      deleteFilter: item => !item.content.getContent().some(value => value && typeof value === 'object' && (value as WriterRecord).key === CLOCK_KEY),
    });
    const undo = this.undoManager.undo.bind(this.undoManager), redo = this.undoManager.redo.bind(this.undoManager);
    this.undoManager.undo = () => { this.assertWriterIdentity(); return undo(); };
    this.undoManager.redo = () => { this.assertWriterIdentity(); return redo(); };
    if (options.undo === false) this.undoManager.destroy();
    doc.on('beforeTransaction', transaction => {
      if (transaction.origin !== this.undoManager || this.clockMode !== 'same-transaction') return;
      const index = this.own.records.toArray().findIndex(record => record.key === CLOCK_KEY);
      if (index < 0) return;
      const item = Y.createRelativePositionFromTypeIndex(this.own.records, index).item;
      if (item) { Y.getItemCleanStart(transaction, item); Y.getItemCleanEnd(transaction, this.doc.store, item); }
    });
    doc.on('beforeObserverCalls', this.discover);
    doc.on('afterTransaction', () => this.pending.clear());
  }

  private assertWriterIdentity(): void {
    if (String(this.doc.clientID) !== this.actor) throw new Error('Writer identity changed after a Yjs client-ID collision; reload the board before editing.');
  }

  private discover = (): void => {
    if (this.discovering) return;
    this.discovering = true;
    try {
      for (const name of this.doc.share.keys()) {
        if (!name.startsWith(WRITER_PREFIX)) continue;
        const actor = name.slice(WRITER_PREFIX.length);
        if (this.writers.has(actor)) continue;
        const records = this.doc.getArray<WriterRecord>(name), kv = new YKeyValue(records);
        this.writers.set(actor, { records, kv });
        const refresh = (key: string): void => this.refresh(key);
        for (const key of kv.map.keys()) refresh(key);
        kv.on('change', (changes: Map<string, unknown>) => { for (const key of changes.keys()) refresh(key); });
      }
    } finally { this.discovering = false; }
  };

  private refresh(key: string): void {
    let winner: StampedValue | undefined;
    for (const writer of this.writers.values()) {
      const value = writer.kv.get(key);
      if (!value) continue;
      this.maxClock = Math.max(this.maxClock, value.stamp.clock);
      if (!winner || compare(value, winner) > 0) winner = value;
    }
    if (winner) this.winners.set(key, winner); else this.winners.delete(key);
  }

  private get(key: string): unknown { return (this.pending.get(key) ?? this.winners.get(key))?.value; }
  private keys(): string[] { return [...new Set([...this.winners.keys(), ...this.pending.keys()])]; }
  private set(key: string, value: unknown): void {
    const stamped: StampedValue = { stamp: { clock: ++this.maxClock, actor: this.actor }, value };
    this.own.kv.set(key, stamped); this.pending.set(key, stamped);
  }
  private writeClock(): void {
    const existing = this.own.kv.get(CLOCK_KEY);
    if (existing && existing.stamp.clock >= this.maxClock) return;
    this.own.kv.set(CLOCK_KEY, { stamp: { clock: this.maxClock, actor: this.actor }, value: this.maxClock });
  }

  transact<T>(fn: () => T): T {
    this.assertWriterIdentity();
    const outer = this.depth++ === 0;
    try {
      const result = this.doc.transact(() => {
        const value = fn();
        if (outer && this.clockMode === 'same-transaction') this.writeClock();
        return value;
      }, LOCAL_ORIGIN);
      if (outer && this.clockMode === 'separate-untracked') this.doc.transact(() => this.writeClock(), CLOCK_ORIGIN);
      return result;
    } finally { this.depth--; }
  }

  base(id: string): BaseRecord | undefined { return structuredClone(this.get(baseKey(id)) ?? undefined) as BaseRecord | undefined; }
  add(element: Element): Element {
    assertValidElement(element);
    if (this.base(element.id)) throw new Error(`Element already exists: ${element.id}`);
    const generation = `${this.actor}:${Y.getState(this.doc.store, this.doc.clientID)}`;
    this.transact(() => this.set(baseKey(element.id), { generation, element: structuredClone(element) }));
    return structuredClone(element);
  }
  create<T extends ElementType>(type: T, input: ElementInput<T> = {}): ElementOf<T> { return this.add(createElement(type, input) as Element) as ElementOf<T>; }
  read(id: string): Element | undefined {
    const base = this.base(id);
    if (!base) return undefined;
    const element = base.element;
    for (const field of FIELDS) {
      const value = this.get(fieldKey(id, base.generation, field));
      if (value !== undefined) Object.assign(element, { [field]: structuredClone(value) });
    }
    assertValidElement(element); return deriveElementGeometry(element);
  }
  readAll(): Element[] {
    return this.keys().flatMap(key => {
      const parts = JSON.parse(key) as string[];
      const element = parts.length === 2 && parts[1] === '$base' ? this.read(parts[0]!) : undefined;
      return element ? [element] : [];
    }).sort(compareElements);
  }
  update(id: string, patch: ElementPatch): boolean {
    const element = this.read(id), base = this.base(id); if (!element || !base) return false;
    const prepared = structuredClone(patch);
    for (const key of Object.keys(prepared)) if (!FIELDS.includes(key as typeof FIELDS[number])) throw new Error(`Immutable or unknown element field: ${key}`);
    assertValidElement({ ...element, ...prepared });
    this.transact(() => { for (const [key, value] of Object.entries(prepared)) this.set(fieldKey(id, base.generation, key), value); });
    return true;
  }
  updateStyle(ids: readonly string[], patch: Partial<ElementStyle>): void {
    this.transact(() => { for (const id of ids) { const element = this.read(id); if (element) this.update(id, { style: { ...element.style, ...patch } }); } });
  }
  move(ids: readonly string[], delta: Point): void {
    const selected = new Set(ids), elements = new Map(this.readAll().map(element => [element.id, element]));
    this.transact(() => {
      for (const id of ids) {
        const element = this.read(id); if (!element) continue;
        if (element.type === 'stroke') this.update(id, { props: { ...element.props, points: element.props.points.map((n, i) => i % 3 === 0 ? n + delta.x : i % 3 === 1 ? n + delta.y : n) } });
        else if (element.type === 'connector') {
          const moveBinding = (binding: Binding): Binding => { if ('elementId' in binding && selected.has(binding.elementId)) return binding; const p = resolveBinding(binding, elements); return { x: p.x + delta.x, y: p.y + delta.y }; };
          this.update(id, { props: { ...element.props, start: moveBinding(element.props.start), end: moveBinding(element.props.end) } });
        } else this.update(id, { x: element.x + delta.x, y: element.y + delta.y });
      }
    });
  }
  delete(ids: string | readonly string[]): void {
    const deleted = new Set(typeof ids === 'string' ? [ids] : ids), elements = new Map(this.readAll().map(element => [element.id, element]));
    this.transact(() => {
      for (const element of elements.values()) {
        if (element.type !== 'connector' || deleted.has(element.id)) continue;
        const detach = (binding: Binding): Binding => 'elementId' in binding && deleted.has(binding.elementId) ? resolveBinding(binding, elements) : binding;
        const start = detach(element.props.start), end = detach(element.props.end);
        if (start !== element.props.start || end !== element.props.end) this.update(element.id, { props: { ...element.props, start, end } });
      }
      for (const id of deleted) if (this.base(id)) this.set(baseKey(id), null);
    });
  }
  destroy(): void { this.undoManager.destroy(); this.doc.off('beforeObserverCalls', this.discover); for (const writer of this.writers.values()) writer.kv.destroy(); this.doc.destroy(); }
}
