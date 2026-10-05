import * as Y from 'yjs';

const storageError = () => new Error('This browser could not save your board. Keep this tab open and export your work before reloading. Check available browser storage.');

/** Append Yjs updates in transactions, so two tabs cannot overwrite each other's saves. */
export class DemoStorage {
  private queued: Uint8Array[] = [];
  private writing: Promise<void> | undefined;
  private stopped = false;
  private readonly update = (bytes: Uint8Array, origin: unknown) => {
    if (origin === this || this.stopped) return;
    this.queued.push(bytes);
    void this.flush().catch(() => {}); // Reported by the storage-status callback.
  };

  private constructor(private db: IDBDatabase, private doc: Y.Doc, private status: (saving: boolean, error?: Error) => void) {
    doc.on('update', this.update);
    db.onversionchange = () => { db.close(); status(false, storageError()); };
  }

  static async open(id: string, doc: Y.Doc, status: (saving: boolean, error?: Error) => void): Promise<DemoStorage> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`whiteboard-demo:${id}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('updates', { autoIncrement: true });
      request.onerror = () => reject(storageError());
      request.onblocked = () => reject(new Error('Close other whiteboard tabs, then try opening this board again.'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('updates', 'readonly');
        const request = transaction.objectStore('updates').getAll();
        request.onsuccess = () => {
          try { Y.transact(doc, () => { for (const bytes of request.result as Uint8Array[]) Y.applyUpdate(doc, bytes); }); }
          catch { transaction.abort(); }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error('The locally saved board could not be opened. Your browser data has been kept.'));
        transaction.onerror = () => {}; // The abort handler owns rejection.
      });
      return new DemoStorage(db, doc, status);
    } catch (error) { db.close(); throw error; }
  }

  flush(): Promise<void> {
    // Recheck after completion, including updates queued by another promise's
    // continuation between the final transaction and our cleanup callback.
    if (this.writing) return this.writing.then(() => this.flush());
    if (!this.queued.length) return Promise.resolve();
    this.status(true);
    this.writing = (async () => {
      while (this.queued.length) {
        const batch = this.queued.slice();
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db.transaction('updates', 'readwrite');
          for (const update of batch) transaction.objectStore('updates').add(update);
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(storageError());
          transaction.onerror = () => {};
        });
        this.queued.splice(0, batch.length);
      }
      this.status(false);
    })().catch(error => { const failure = error instanceof Error ? error : storageError(); this.status(false, failure); throw failure; })
      .finally(() => { this.writing = undefined; });
    return this.writing;
  }

  async destroy(): Promise<void> {
    this.stopped = true; this.doc.off('update', this.update);
    try { await this.flush(); } finally { this.db.close(); }
  }
}
