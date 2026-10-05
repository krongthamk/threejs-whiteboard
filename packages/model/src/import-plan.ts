import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import { BoardDocument } from './document.js';
import { BoardUpdateValidator } from './document-validation.js';
import { MAX_IMPORT_ELEMENTS, MAX_EXCALIDRAW_IMAGES } from './excalidraw.js';
import { assertValidElement, isWellFormedString } from './schema.js';
import { checkUpdateResources } from './update-limits.js';
import type { Element } from './types.js';

export interface ImportBudget {
  maxUpdateBytes: number;
  maxBoardBytes: number;
  maxInboundBytes: number;
  maxClockGrowth: number;
  snapshotBytes: number;
  updateBytes: number;
  /** Authoritative server vector, after draining outstanding local updates. */
  stateVector: Uint8Array;
}
export interface ImportBatch {
  readonly elements: readonly Element[];
  /** A fresh copy of staging evidence, NEVER an update to apply to the live actor. */
  readonly update: Uint8Array;
  readonly payloadBytes: number;
  readonly frameBytes: number;
  readonly acceptedBytes: number;
  readonly reconnectPayloadBytes: number;
  readonly reconnectFrameBytes: number;
}
export interface ImportPlan {
  readonly batches: readonly ImportBatch[];
  readonly totalAcceptedBytes: number;
  readonly storageBytesAfter: number;
}
export interface ImportPlanOptions {
  documentName: string;
  budget: ImportBudget;
  /** Applies only when the entire import cannot be sent as one gesture; at most 500. */
  maxBatchElements?: number;
  /** Bytes reserved for other packets already sharing the server's inbound queue. */
  inboundReserveBytes?: number;
}
export class ImportPlanError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportPlanError'; }
}
const baselines = new WeakMap<ImportPlan, { clientID: number; bytes: Uint8Array }>();
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const safe = (value: unknown, positive = false): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
const reject = (message: string): never => { throw new ImportPlanError(message); };
const sum = (...values: number[]) => {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) reject('Import byte accounting exceeds safe integer limits.');
  return result;
};
function varUintBytes(value: number): number {
  if (!safe(value)) reject('Protocol length must be a nonnegative safe integer.');
  let bytes = 1; while (value >= 128) { value = Math.floor(value / 128); bytes++; } return bytes;
}
/** Hocuspocus named Sync frame: varString(name), message type 0, sync type, varUint8Array(payload). */
export function syncFrameBytes(documentName: string, payloadBytes: number, syncType: 1 | 2 = 2): number {
  if (!isWellFormedString(documentName) || !documentName || syncType !== 1 && syncType !== 2) reject('Invalid import document address or sync type.');
  const nameBytes = new TextEncoder().encode(documentName).length;
  return sum(varUintBytes(nameBytes), nameBytes, 1, varUintBytes(syncType), varUintBytes(payloadBytes), payloadBytes);
}
function vectorBytes(vector: Map<number, number>): Uint8Array {
  const bytes: number[] = [];
  const uint = (value: number) => { while (value >= 128) { bytes.push(value % 128 | 128); value = Math.floor(value / 128); } bytes.push(value); };
  uint(vector.size); for (const [client, clock] of vector) { uint(client); uint(clock); }
  return new Uint8Array(bytes);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function cloneBoard(doc: Y.Doc, actor: number): BoardDocument {
  const stage = new Y.Doc({ gc: doc.gc });
  try {
    Y.applyUpdate(stage, Y.encodeStateAsUpdate(doc), 'baseline');
    if (stage.store.pendingStructs || stage.store.pendingDs) reject('Import baseline has incomplete causal history.');
    stage.clientID = actor;
    const emitted: Uint8Array[] = [], capture = (update: Uint8Array) => { emitted.push(update); };
    stage.on('update', capture);
    const board = new BoardDocument(stage, { initializeMetadata: false, undo: false });
    stage.off('update', capture);
    if (emitted.length) { board.destroy(); reject('Import baseline requires document repair before planning.'); }
    return board;
  } catch (error) { stage.destroy(); throw error; }
}
/** Check immediately before replaying ONLY the first batch, with no await in between. */
export function isImportPlanCurrent(board: BoardDocument, plan: ImportPlan): boolean {
  const baseline = baselines.get(plan);
  return !!baseline && board.doc.clientID === baseline.clientID && board.actor === String(baseline.clientID) && equal(Y.encodeStateAsUpdate(board.doc), baseline.bytes);
}

/**
 * Fully preflight fresh-ID additions without live writes, actor changes, or undo effects.
 * Returned elements are deeply frozen; update evidence is copied on access. Replay only
 * batches[0] synchronously while current. After a commit/await, replan the remaining input
 * using a fresh budget. Never apply staged same-client updates to the live document.
 * Capacity is advisory under peer writes. Earlier planned batches are assumed ACKed when
 * bounding each reconnect suffix, rather than accumulating an unsent multi-batch import.
 */
export function planImport(board: BoardDocument, input: readonly Element[], options: ImportPlanOptions): ImportPlan {
  if (!options || !options.budget) reject('Import budget is missing.');
  const { budget } = options, maximum = options.maxBatchElements === undefined ? 500 : options.maxBatchElements;
  const reserve = options.inboundReserveBytes === undefined ? 0 : options.inboundReserveBytes;
  if (![budget.maxUpdateBytes, budget.maxBoardBytes, budget.maxInboundBytes, budget.maxClockGrowth].every(value => safe(value, true)) ||
    ![budget.snapshotBytes, budget.updateBytes, reserve].every(value => safe(value)) || !safe(maximum, true) || maximum > 500 || !(budget.stateVector instanceof Uint8Array)) reject('Import limits or storage budget are invalid.');
  syncFrameBytes(options.documentName, 0);
  if (reserve >= budget.maxInboundBytes) reject('No inbound capacity remains for the import.');
  if (board.actor !== String(board.doc.clientID)) reject('Import writer identity changed; reload before editing.');
  if (!Array.isArray(input) || input.length > MAX_IMPORT_ELEMENTS || input.filter(e => e?.type === 'image').length > MAX_EXCALIDRAW_IMAGES) reject('Import exceeds the element or image count limit.');
  if (board.doc.store.pendingStructs || board.doc.store.pendingDs) reject('Import baseline has incomplete causal history.');
  const baseline = Y.encodeStateAsUpdate(board.doc), actor = board.doc.clientID;
  const serverVector = Y.decodeStateVector(budget.stateVector);
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(board.doc))) if (clock > (serverVector.get(client) ?? 0)) reject('Import requires acknowledgement of existing local changes.');
  const ids = new Set<string>();
  const elements = input.map(element => {
    assertValidElement(element);
    if (ids.has(element.id) || board.base(element.id)) reject('Import element ID already exists or is duplicated: ' + element.id);
    ids.add(element.id); return structuredClone(element);
  });
  const indexes = generateNKeysBetween(board.highestIndex(), null, elements.length);
  elements.forEach((element, i) => { element.index = indexes[i]!; });
  let storageBytes = sum(budget.snapshotBytes, budget.updateBytes), committed: BoardDocument | undefined;
  if (storageBytes > budget.maxBoardBytes) reject('Board storage limit is already exceeded.');
  const probe = (source: Y.Doc, batch: readonly Element[]) => {
    const candidate = cloneBoard(source, actor);
    let validator: BoardUpdateValidator | undefined;
    try {
      validator = new BoardUpdateValidator(source);
      const emitted: Uint8Array[] = [], capture = (update: Uint8Array) => { emitted.push(update); };
      candidate.doc.on('update', capture);
      try { candidate.transact(() => { for (const element of batch) candidate.add(element); }); }
      finally { candidate.doc.off('update', capture); }
      if (emitted.length !== 1) reject('Import gesture did not emit exactly one update.');
      const update = emitted[0]!, frameBytes = syncFrameBytes(options.documentName, update.length);
      if (update.length > budget.maxUpdateBytes || frameBytes > budget.maxUpdateBytes || sum(frameBytes, reserve) > budget.maxInboundBytes) reject('Import update exceeds the configured frame limit.');
      checkUpdateResources(update, source, budget.maxClockGrowth);
      const accepted = validator.validate(update);
      const acceptedBytes = accepted.length === 2 && accepted[0] === 0 && accepted[1] === 0 ? 0 : accepted.length;
      if (sum(storageBytes, acceptedBytes) > budget.maxBoardBytes) reject('Import exceeds the remaining board storage budget.');
      const reconnect = Y.encodeStateAsUpdate(candidate.doc, vectorBytes(serverVector));
      const reconnectFrameBytes = syncFrameBytes(options.documentName, reconnect.length, 1);
      if (reconnect.length > budget.maxUpdateBytes || reconnectFrameBytes > budget.maxUpdateBytes || sum(reconnectFrameBytes, reserve) > budget.maxInboundBytes) reject('Import reconnect history exceeds the configured frame limit.');
      checkUpdateResources(reconnect, source, budget.maxClockGrowth);
      return { candidate, batch: Object.freeze({ elements: freeze(batch.map(e => structuredClone(e))), get update() { return update.slice(); },
        payloadBytes: update.length, frameBytes, acceptedBytes, reconnectPayloadBytes: reconnect.length, reconnectFrameBytes }) };
    } catch (error) { candidate.destroy(); throw error; }
    finally { validator?.dispose(); }
  };
  const batches: ImportBatch[] = [];
  const accept = (result: ReturnType<typeof probe>) => {
    committed?.destroy(); committed = result.candidate; batches.push(result.batch); storageBytes = sum(storageBytes, result.batch.acceptedBytes);
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(committed.doc))) serverVector.set(client, Math.max(clock, serverVector.get(client) ?? 0));
  };
  try {
    if (elements.length) {
      try { accept(probe(board.doc, elements)); }
      catch {
        let position = 0, targetSize = Math.min(maximum, elements.length === maximum ? Math.max(1, Math.floor(maximum / 2)) : maximum);
        while (position < elements.length) {
          let size = Math.min(targetSize, elements.length - position);
          for (;;) {
            try { accept(probe(committed?.doc ?? board.doc, elements.slice(position, position + size))); position += size; break; }
            catch (error) {
              if (size === 1) reject('Import element at position ' + (position + 1) + ' cannot be sent: ' + (error instanceof Error ? error.message : String(error)));
              size = Math.max(1, Math.floor(size / 2)); targetSize = Math.min(targetSize, size);
            }
          }
        }
      }
    }
    const plan: ImportPlan = Object.freeze({ batches: Object.freeze(batches), totalAcceptedBytes: storageBytes - budget.snapshotBytes - budget.updateBytes, storageBytesAfter: storageBytes });
    baselines.set(plan, { clientID: actor, bytes: baseline }); return plan;
  } finally { committed?.destroy(); }
}
