import type { ImportBudget } from '@whiteboard/model';

/** A lease ends on disconnect, permission change, refusal, or editor shutdown. */
export interface ImportLease {
  readonly signal: AbortSignal;
  assertReady(): void;
  budget(): Promise<ImportBudget>;
  /** Await remote SyncStatus acknowledgments, or the local storage transaction in the browser-only demo. */
  waitAcknowledged(): Promise<void>;
  release(): void;
}
export interface ImportTransport { beginImport(signal: AbortSignal): ImportLease }
