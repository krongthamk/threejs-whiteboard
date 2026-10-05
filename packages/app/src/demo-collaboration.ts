import * as Y from 'yjs';
import { BoardDocument } from '@whiteboard/model';
import type { BoardInfo, Session } from './api';
import type { ConnectionCallbacks, Presence, RemotePresence } from './collaboration';
import type { ImportLease, ImportTransport } from './import-transport';
import { DemoStorage } from './demo-storage';
import { attachDemoBoard, demoApi } from './demo-workspace';

type Message = { kind: 'sync'; vector: Uint8Array } | { kind: 'update'; update: Uint8Array }
  | { kind: 'presence'; presence: RemotePresence } | { kind: 'leave'; clientId: number };

/** Anonymous, same-origin tab collaboration. This transport never opens a socket. */
export class DemoConnection implements ImportTransport {
  private readonly channel: BroadcastChannel;
  private readonly peers = new Map<number, { presence: RemotePresence; seen: number }>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly detach: () => void;
  private readonly closed = new AbortController();
  private presence: RemotePresence;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly update = (bytes: Uint8Array, origin: unknown) => {
    if (origin !== this.channel) this.send({ kind: 'update', update: bytes });
  };
  private readonly onPageHide = () => this.send({ kind: 'leave', clientId: this.board.doc.clientID });
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.requestSync();
  };

  private constructor(readonly board: BoardDocument, private storage: DemoStorage, private info: BoardInfo, session: Session, private callbacks: ConnectionCallbacks) {
    this.channel = new BroadcastChannel(`whiteboard-demo:${info.id}`);
    this.detach = attachDemoBoard(info, board, storage, callbacks.onError);
    this.presence = { clientId: board.doc.clientID, userId: session.user.id, name: session.user.username, color: session.user.color ?? '#5267ce', cursor: null, selection: [], editingTextId: null };
    board.doc.on('update', this.update);
    this.channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      try {
        if (message.kind === 'sync') {
          this.send({ kind: 'update', update: Y.encodeStateAsUpdate(board.doc, message.vector) });
          this.sendPresence();
        } else if (message.kind === 'update') Y.applyUpdate(board.doc, message.update, this.channel);
        else if (message.kind === 'presence') {
          this.peers.set(message.presence.clientId, { presence: message.presence, seen: Date.now() }); this.showPeers();
        } else if (message.kind === 'leave') { this.peers.delete(message.clientId); this.showPeers(); }
      } catch { callbacks.onError('A change from another tab could not be loaded. Reopen the board to recover locally saved changes.'); }
    };
    this.heartbeat = setInterval(() => {
      for (const [id, peer] of this.peers) if (Date.now() - peer.seen > 30_000) this.peers.delete(id);
      this.showPeers(); this.requestSync();
    }, 10_000);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisible);
    callbacks.onReadOnly(false); callbacks.onStatus('live');
    this.requestSync();
  }

  static async open(info: BoardInfo, session: Session, callbacks: ConnectionCallbacks): Promise<DemoConnection> {
    const doc = new Y.Doc();
    let storage: DemoStorage | undefined;
    try {
      storage = await DemoStorage.open(info.id, doc, (saving, error) => {
        callbacks.onStatus(error ? 'offline' : saving ? 'connecting' : 'live');
        if (error) callbacks.onError(error.message);
      });
      const initialized = doc.getMap('meta').has('schemaVersion');
      const board = new BoardDocument(doc);
      if (!initialized) board.meta.set('title', info.title);
      await storage.flush();
      return new DemoConnection(board, storage, info, session, callbacks);
    } catch (error) { await storage?.destroy().catch(() => {}); doc.destroy(); throw error; }
  }

  private send(message: Message): void { if (!this.closed.signal.aborted) this.channel.postMessage(message); }
  private sendPresence(): void { this.send({ kind: 'presence', presence: this.presence }); }
  private requestSync(): void { this.send({ kind: 'sync', vector: Y.encodeStateVector(this.board.doc) }); this.sendPresence(); }
  private showPeers(): void { this.callbacks.onPresence([...this.peers.values()].map(peer => peer.presence)); }
  setPresence(patch: Partial<Pick<Presence, 'cursor' | 'selection' | 'editingTextId' | 'viewport'>>): void {
    this.presence = { ...this.presence, ...patch };
    if (this.presenceTimer || this.closed.signal.aborted) return;
    this.presenceTimer = setTimeout(() => { this.presenceTimer = undefined; this.sendPresence(); }, 50);
  }
  beginImport(signal: AbortSignal): ImportLease {
    const released = new AbortController();
    const combined = AbortSignal.any([signal, released.signal, this.closed.signal]);
    const assertReady = () => combined.throwIfAborted();
    return {
      signal: combined, assertReady,
      budget: async () => {
        assertReady(); const response = await demoApi.importBudget(this.info.id); assertReady();
        return { ...response.limits, ...response.storage, stateVector: Uint8Array.from(atob(response.stateVector), byte => byte.charCodeAt(0)) };
      },
      waitAcknowledged: async () => { assertReady(); await this.storage.flush(); assertReady(); },
      release: () => released.abort(),
    };
  }
  retrySync(): void { this.requestSync(); void this.storage.flush().catch(() => {}); }
  // The demo has no server copy to discard toward; this action is never presented.
  discardLocalChanges(): void {}
  async destroy(): Promise<void> {
    if (this.closed.signal.aborted) return;
    this.onPageHide(); this.closed.abort(new Error('The board closed during import.'));
    clearInterval(this.heartbeat); clearTimeout(this.presenceTimer);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.board.doc.off('update', this.update); this.channel.close(); this.detach();
    await this.storage.destroy().catch(() => {});
  }
}
