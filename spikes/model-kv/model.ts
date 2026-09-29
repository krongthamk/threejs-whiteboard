import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import {
  assertValidElement, compareElements, createElement, deriveElementGeometry, LOCAL_ORIGIN, resolveBinding,
  type Binding, type Element, type ElementInput, type ElementOf, type ElementPatch, type ElementStyle, type ElementType, type Point,
} from '../../packages/model/src/index.js';

export const RECORDS_NAME = 'element-properties';
export const KV_CLEANUP = Symbol('whiteboard.kv.cleanup');
export const FIELDS = ['x', 'y', 'w', 'h', 'rotation', 'index', 'style', 'props'] as const;
export type BaseRecord = { generation: string; element: Element };
export type KeyValueRecord = { key: string; val: unknown };
export const baseKey = (id: string): string => JSON.stringify([id, '$base']);
export const fieldKey = (id: string, generation: string, field: string): string => JSON.stringify([id, generation, field]);

/** Isolated schema candidate; the production @whiteboard/model remains unchanged. */
export class KvBoardDocument {
  readonly doc: Y.Doc;
  readonly records: Y.Array<KeyValueRecord>;
  readonly kv: YKeyValue<unknown>;
  readonly undoManager: Y.UndoManager;
  /** A write-through buffer only for the current transaction, because YKeyValue updates its cache in observers. */
  private pending = new Map<string, unknown>();
  private cleaning = false;

  constructor(doc = new Y.Doc()) {
    this.doc = doc;
    this.records = doc.getArray<KeyValueRecord>(RECORDS_NAME);
    this.kv = new YKeyValue(this.records);
    this.undoManager = new Y.UndoManager(this.records, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    this.kv.on('change', () => this.cleanupOrphans());
    doc.on('afterTransaction', () => this.pending.clear());
    this.cleanupOrphans();
  }

  transact<T>(fn: () => T): T { return this.doc.transact(fn, LOCAL_ORIGIN); }
  private get(key: string): unknown { return this.pending.has(key) ? this.pending.get(key) : this.kv.get(key); }
  private set(key: string, value: unknown): void { this.kv.set(key, value); this.pending.set(key, value); }
  private remove(key: string): void { this.kv.delete(key); this.pending.set(key, undefined); }
  private keys(): string[] { return [...new Set([...this.kv.map.keys(), ...this.pending.keys()])]; }
  base(id: string): BaseRecord | undefined { return structuredClone(this.get(baseKey(id))) as BaseRecord | undefined; }

  private cleanupOrphans(): void {
    if (this.cleaning) return;
    const orphanKeys = [...this.kv.map.keys()].filter(key => {
      const parts = JSON.parse(key) as string[];
      return parts.length === 3 && this.base(parts[0]!)?.generation !== parts[1];
    });
    if (!orphanKeys.length) return;
    this.cleaning = true;
    try { this.doc.transact(() => { for (const key of orphanKeys) this.kv.delete(key); }, KV_CLEANUP); }
    finally { this.cleaning = false; }
  }

  add(element: Element): Element {
    assertValidElement(element);
    if (this.base(element.id)) throw new Error(`Element already exists: ${element.id}`);
    const generation = `${this.doc.clientID}:${Y.getState(this.doc.store, this.doc.clientID)}`;
    const copy = structuredClone(element);
    this.transact(() => this.set(baseKey(element.id), { generation, element: copy }));
    return structuredClone(copy);
  }

  create<T extends ElementType>(type: T, input: ElementInput<T> = {}): ElementOf<T> {
    return this.add(createElement(type, input) as Element) as ElementOf<T>;
  }

  read(id: string): Element | undefined {
    const base = this.base(id);
    if (!base) return undefined;
    const result = base.element;
    for (const field of FIELDS) {
      const value = this.get(fieldKey(id, base.generation, field));
      if (value !== undefined) Object.assign(result, { [field]: structuredClone(value) });
    }
    assertValidElement(result);
    return deriveElementGeometry(result);
  }

  readAll(): Element[] {
    return this.keys().flatMap(key => {
      const parts = JSON.parse(key) as string[];
      const element = parts.length === 2 && parts[1] === '$base' ? this.read(parts[0]!) : undefined;
      return element ? [element] : [];
    }).sort(compareElements);
  }

  update(id: string, patch: ElementPatch): boolean {
    const element = this.read(id), base = this.base(id);
    if (!element || !base) return false;
    const prepared = structuredClone(patch);
    for (const key of Object.keys(prepared)) if (!FIELDS.includes(key as typeof FIELDS[number])) throw new Error(`Immutable or unknown element field: ${key}`);
    assertValidElement({ ...element, ...prepared });
    this.transact(() => {
      for (const [key, value] of Object.entries(prepared)) this.set(fieldKey(id, base.generation, key), value);
    });
    return true;
  }

  updateStyle(ids: readonly string[], patch: Partial<ElementStyle>): void {
    this.transact(() => { for (const id of ids) { const element = this.read(id); if (element) this.update(id, { style: { ...element.style, ...patch } }); } });
  }

  move(ids: readonly string[], delta: Point): void {
    const selected = new Set(ids), map = new Map(this.readAll().map(element => [element.id, element]));
    this.transact(() => {
      for (const id of ids) {
        const element = this.read(id);
        if (!element) continue;
        if (element.type === 'stroke') this.update(id, { props: { ...element.props, points: element.props.points.map((n, i) => i % 3 === 0 ? n + delta.x : i % 3 === 1 ? n + delta.y : n) } });
        else if (element.type === 'connector') {
          const moveBinding = (binding: Binding): Binding => {
            if ('elementId' in binding && selected.has(binding.elementId)) return binding;
            const point = resolveBinding(binding, map); return { x: point.x + delta.x, y: point.y + delta.y };
          };
          this.update(id, { props: { ...element.props, start: moveBinding(element.props.start), end: moveBinding(element.props.end) } });
        } else this.update(id, { x: element.x + delta.x, y: element.y + delta.y });
      }
    });
  }

  delete(ids: string | readonly string[]): void {
    const deleted = new Set(typeof ids === 'string' ? [ids] : ids);
    const elements = new Map(this.readAll().map(element => [element.id, element]));
    this.transact(() => {
      for (const element of elements.values()) {
        if (element.type !== 'connector' || deleted.has(element.id)) continue;
        const detach = (binding: Binding): Binding => 'elementId' in binding && deleted.has(binding.elementId) ? resolveBinding(binding, elements) : binding;
        const start = detach(element.props.start), end = detach(element.props.end);
        if (start !== element.props.start || end !== element.props.end) this.update(element.id, { props: { ...element.props, start, end } });
      }
      for (const key of this.keys()) if (deleted.has((JSON.parse(key) as string[])[0]!)) this.remove(key);
    });
  }

  destroy(): void { this.undoManager.destroy(); this.kv.destroy(); this.doc.destroy(); }
}
