import type { ImportBudget } from '@whiteboard/model';

/** A lease ends on disconnect, permission change, refusal, or editor shutdown. */
export interface ImportLease {
  readonly signal: AbortSignal;
  assertReady(): void;
  budget(): Promise<ImportBudget>;
  /** Drain actual provider SyncStatus acknowledgments, not a local write counter. */
  waitAcknowledged(): Promise<void>;
  release(): void;
}
export interface ImportTransport { beginImport(signal: AbortSignal): ImportLease }
