import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { IndexeddbPersistence, fetchUpdates } from 'y-indexeddb';
import { BoardDocument, type Point, type Box } from '@whiteboard/model';
import { api, type BoardInfo, type Session } from './api';

export type ConnectionStatus = 'connecting' | 'live' | 'offline' | 'reconnecting' | 'unauthorized' | 'limited';
export interface SyncBlockedState {
  reason: 'board-full' | 'update-too-large' | 'inbound-overload' | 'incomplete-update';
  retryable: boolean;
  maxBytes?: number;
  retrying?: boolean;
}
export interface Presence {
  userId: string; name: string; color: string;
  cursor: Point | null; selection: string[]; editingTextId: string | null; viewport?: Box;
}
export interface RemotePresence extends Presence { clientId: number }
export interface ConnectionCallbacks {
  onStatus(status: ConnectionStatus): void;
  onReadOnly(readOnly: boolean): void;
  onPresence(presence: RemotePresence[]): void;
  onError(message: string): void;
  onPermissionChange(reason?: string): void;
  onSyncBlocked?(state: SyncBlockedState | null): void;
}

function syncRejection(value: unknown): SyncBlockedState | null {
  if (!value || typeof value !== 'object' || !('reason' in value)) return null;
  const reason = value.reason;
  if (reason !== 'board-full' && reason !== 'update-too-large' && reason !== 'inbound-overload' && reason !== 'incomplete-update') return null;
  return { reason, retryable: reason !== 'update-too-large' && 'retryable' in value && value.retryable === true,
    ...('maxBytes' in value && typeof value.maxBytes === 'number' && Number.isSafeInteger(value.maxBytes) && value.maxBytes > 0 ? { maxBytes: value.maxBytes } : {}) };
}
function storedBlock(raw: string | null, epoch: string): SyncBlockedState | null {
  try { const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && 'epoch' in value && value.epoch === epoch ? syncRejection(value) : null;
  } catch { return null; }
}

const colors = ['#5267ce', '#c46135', '#24836e', '#a64d83', '#785db2', '#25779b'];
function colorFor(id: string): string {
  let hash = 0; for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return colors[(hash >>> 0) % colors.length]!;
}
function parsePresence(clientId: number, state: Record<string, unknown>): RemotePresence | null {
  if (typeof state.userId !== 'string' || typeof state.name !== 'string') return null;
  const raw = state.cursor as Partial<Point> | null;
  const cursor = raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? { x: raw.x!, y: raw.y! } : null;
  return {
    clientId, userId: state.userId.slice(0, 100), name: state.name.slice(0, 80),
    color: typeof state.color === 'string' && /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : colorFor(state.userId),
    cursor, selection: Array.isArray(state.selection) ? state.selection.filter((id): id is string => typeof id === 'string').slice(0, 1000) : [],
    editingTextId: typeof state.editingTextId === 'string' ? state.editingTextId : null,
  };
}

/** Owns transport and local durable storage, separate from the editor's session state. */
export class BoardConnection {
  readonly board: BoardDocument;
  readonly provider: HocuspocusProvider;
  readonly persistence: IndexeddbPersistence;
  private readonly socket: HocuspocusProviderWebsocket;
  private presence: Presence;
  private sentPresence = '';
  private lastPresenceAt = -Infinity;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceRetry: ReturnType<typeof setTimeout> | undefined;
  private presenceFrame = 0;
  private everLive = false;
  private destroyed = false;
  private authorizationFailed = false;
  private session: Session;
  private permissionReset = false;
  private discardPersistence = false;
  private readonly cacheEpochKey: string;
  private readonly blockedKey: string;
  private blocked: SyncBlockedState | null = null;
  private blockedMarker: string | null = null;
  private retrying = false;
  private retrySynced = false;
  private finishingRetry = false;
  private scopeReadOnly = false;
  private readonly storageChanged = (event: StorageEvent) => {
    if (event.key === this.cacheEpochKey && event.newValue !== event.oldValue) this.resetPermissions(false, 'cache-reset');
    if (event.key === this.blockedKey) {
      const state = storedBlock(event.newValue, this.cacheEpoch);
      if (state) { this.blockedMarker = event.newValue; this.pauseSync(state, false); }
    }
  };

  private constructor(board: BoardDocument, persistence: IndexeddbPersistence, session: Session, info: BoardInfo, private callbacks: ConnectionCallbacks, private readonly cacheEpoch: string) {
    this.board = board; this.persistence = persistence; this.session = session;
    this.cacheEpochKey = `whiteboard:${session.user.id}:${info.id}:cache-epoch`;
    this.blockedKey = `whiteboard:${session.user.id}:${info.id}:sync-blocked`;
    const sharedMarker = localStorage.getItem(this.blockedKey);
    let tabMarker: string | null = null;
    try { tabMarker = sessionStorage.getItem(this.blockedKey); } catch { /* Shared storage still guards new tabs. */ }
    this.blockedMarker = storedBlock(tabMarker, cacheEpoch) ? tabMarker : sharedMarker;
    this.blocked = storedBlock(this.blockedMarker, cacheEpoch);
    if (this.blocked && this.blockedMarker) this.saveTabBlock();
    window.addEventListener('storage', this.storageChanged);
    this.presence = { userId: session.user.id, name: session.user.name ?? session.user.username, color: session.user.color ?? colorFor(session.user.id), cursor: null, selection: [], editingTextId: null };
    this.scopeReadOnly = info.role === 'viewer';
    callbacks.onReadOnly(this.scopeReadOnly || !!this.blocked); callbacks.onStatus(this.blocked ? 'limited' : 'connecting');
    if (this.blocked) callbacks.onSyncBlocked?.(this.blocked);
    const url = new URL('/collaboration', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('boardId', info.id);
    // Attach before connecting so a retained blocked cache never reaches the wire.
    this.socket = new HocuspocusProviderWebsocket({ url: url.href, autoConnect: false });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket, name: info.id, document: board.doc,
      token: async () => {
        if (this.session.expiresAt > Date.now() + 60_000) return this.session.token;
        try {
          const next = await api.session();
          if (next.user.id !== session.user.id) throw new Error('The signed-in account changed. Reopen the board.');
          this.session = next; return next.token;
        } catch { callbacks.onError('Your session could not be renewed. Sign in again to reconnect.'); return ''; }
      },
      onAuthenticated: ({ scope }) => {
        if (this.destroyed || this.permissionReset || this.blocked && !this.retrying) return;
        this.authorizationFailed = false;
        clearTimeout(this.persistenceRetry);
        this.scopeReadOnly = scope === 'readonly';
        callbacks.onReadOnly(this.scopeReadOnly || !!this.blocked);
      },
      onAuthenticationFailed: ({ reason }) => {
        if (this.destroyed || this.permissionReset || this.blocked && !this.retrying) return;
        if (this.retrying) { this.pauseSync(this.blocked!); return; }
        if (reason === 'persistence-failed') {
          // Hocuspocus denies authentication without closing the socket. Retry
          // with the same replica rather than leaving it apparently connected.
          this.socket.disconnect();
          callbacks.onStatus('reconnecting');
          callbacks.onError('The server could not save your changes. They are saved on this device and will retry when it reconnects.');
          clearTimeout(this.persistenceRetry);
          this.persistenceRetry = setTimeout(() => {
            if (!this.destroyed && !this.permissionReset && !this.blocked) void this.socket.connect().catch(() => {});
          }, 1000);
          return;
        }
        this.authorizationFailed = true; callbacks.onReadOnly(true); callbacks.onStatus('unauthorized');
        callbacks.onError('Access to this board could not be confirmed. Sign in again or contact its owner.');
      },
      onStateless: ({ payload }) => {
        if (this.destroyed || this.permissionReset) return;
        let message: unknown; try { message = JSON.parse(payload); } catch { return; }
        if (message && typeof message === 'object' && 'boardId' in message && message.boardId === info.id
          && 'type' in message && (message.type === 'board-full' || message.type === 'sync-rejected')) {
          const rejection = syncRejection(message);
          if (rejection) this.pauseSync(rejection);
          return;
        }
        if (message && typeof message === 'object' && 'type' in message && message.type === 'permission-changed'
          && 'boardId' in message && message.boardId === info.id && 'resetRequired' in message && message.resetRequired === true) {
          if ('reason' in message && message.reason === 'persistence-failed') {
            if (this.blocked) return;
            // Let the provider reconnect with this Doc and the same durable cache.
            // Rotating a permission-reset cache here would lose accepted edits.
            callbacks.onStatus('reconnecting');
            callbacks.onError('The server could not save your changes. They are saved on this device and will retry when it reconnects.');
          } else this.resetPermissions(true, 'reason' in message && typeof message.reason === 'string' ? message.reason : 'permissions-changed');
        }
      },
      onClose: ({ event }) => {
        if (this.destroyed || this.permissionReset) return;
        const rejection = syncRejection({ reason: event.code === 1009 ? 'update-too-large' : event.reason,
          retryable: event.reason === 'board-full' || event.reason === 'inbound-overload' || event.reason === 'incomplete-update' });
        if (rejection) this.pauseSync(rejection);
        else if (this.retrying) this.pauseSync(this.blocked!);
      },
      onStatus: ({ status }) => {
        if (this.destroyed || this.authorizationFailed || this.blocked && !this.retrying) return;
        if (status === 'disconnected') callbacks.onStatus('offline');
        else callbacks.onStatus(this.everLive ? 'reconnecting' : 'connecting');
      },
      onSynced: ({ state }) => {
        if (!state || this.destroyed || this.authorizationFailed || this.blocked && !this.retrying) return;
        if (this.retrying) { this.retrySynced = true; void this.finishRetry(); return; }
        this.everLive = true; callbacks.onStatus('live');
      },
      onUnsyncedChanges: ({ number }) => { if (number === 0) void this.finishRetry(); },
      onAwarenessUpdate: () => {
        if (this.destroyed) return;
        // Forty peers can deliver 800 packets/s. Project only the latest state per frame.
        if (!this.presenceFrame) this.presenceFrame = requestAnimationFrame(() => {
          this.presenceFrame = 0;
          if (this.destroyed) return;
          callbacks.onPresence([...(this.provider.awareness?.getStates() ?? [])].flatMap(([clientId, state]) => {
            if (clientId === board.doc.clientID) return [];
            const parsed = parsePresence(clientId, state); return parsed ? [parsed] : [];
          }));
        });
      },
    });
    // This connection owns the socket exclusively. Keep the provider's public
    // connect/disconnect and destroy lifecycle working for this owned socket.
    this.provider.manageSocket = true;
    this.provider.attach();
    if (!this.blocked) { this.flushPresence(); void this.socket.connect().catch(() => {}); }
  }

  static async open(info: BoardInfo, session: Session, callbacks: ConnectionCallbacks): Promise<BoardConnection> {
    const doc = new Y.Doc();
    const base = `whiteboard:${session.user.id}:${info.id}`;
    const epochKey = `${base}:cache-epoch`;
    let epoch = localStorage.getItem(epochKey);
    if (!epoch) { epoch = crypto.randomUUID(); localStorage.setItem(epochKey, epoch); }
    const persistence = new IndexeddbPersistence(`${base}:${epoch}`, doc);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([persistence.whenSynced, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Local board storage did not open. Check browser storage access and try again.')), 10_000);
      })]);
      return new BoardConnection(new BoardDocument(doc, { initializeMetadata: false }), persistence, session, info, callbacks, epoch);
    } catch (error) { void persistence.destroy(); doc.destroy(); throw error; }
    finally { clearTimeout(timeout); }
  }

  private resetPermissions(rotateCache: boolean, reason = 'permissions-changed'): void {
    if (this.destroyed || this.permissionReset) return;
    this.permissionReset = true; this.authorizationFailed = true; this.discardPersistence = true;
    this.callbacks.onReadOnly(true);
    clearTimeout(this.persistenceRetry); this.retrying = false;
    this.socket.disconnect();
    localStorage.removeItem(this.blockedKey);
    try { sessionStorage.removeItem(this.blockedKey); } catch { /* A new epoch makes stale tab markers inert. */ }
    if (rotateCache) localStorage.setItem(this.cacheEpochKey, crypto.randomUUID());
    // Reopening uses a new cache namespace even if another tab delays old DB deletion.
    this.callbacks.onPermissionChange(reason);
  }

  private pauseSync(state: SyncBlockedState, persist = true): void {
    if (this.destroyed || this.permissionReset) return;
    this.blocked = { ...state, retrying: false }; this.retrying = false; this.retrySynced = false;
    clearTimeout(this.persistenceRetry); clearTimeout(this.presenceTimer); this.presenceTimer = undefined;
    this.socket.disconnect();
    if (persist) {
      try {
        this.blockedMarker = JSON.stringify({ epoch: this.cacheEpoch, revision: crypto.randomUUID(), ...this.blocked });
        localStorage.setItem(this.blockedKey, this.blockedMarker);
      }
      catch { this.callbacks.onError('Sync is paused, but the recovery status could not be saved. Keep this tab open and export your work before reopening.'); }
    }
    this.saveTabBlock();
    this.callbacks.onReadOnly(true); this.callbacks.onStatus('limited'); this.callbacks.onSyncBlocked?.(this.blocked);
  }

  /** One explicit attempt. A failed connection or another refusal returns to the retained paused replica. */
  async retrySync(): Promise<void> {
    if (!this.blocked?.retryable || this.retrying || this.destroyed || this.permissionReset) return;
    this.retrying = true; this.retrySynced = false;
    this.callbacks.onStatus('reconnecting'); this.callbacks.onSyncBlocked?.({ ...this.blocked, retrying: true });
    try {
      // IndexedDB is shared across tabs; this Doc may not yet contain their edits.
      await fetchUpdates(this.persistence);
      if (!this.retrying || this.destroyed || this.permissionReset) return;
      await this.socket.connect();
    } catch { if (this.retrying && this.blocked) this.pauseSync(this.blocked); }
  }

  private saveTabBlock(): void {
    try { if (this.blockedMarker) sessionStorage.setItem(this.blockedKey, this.blockedMarker); }
    catch { this.callbacks.onError('Keep this tab open until you export your local work; this browser could not save its paused-sync status.'); }
  }

  private async finishRetry(): Promise<void> {
    if (!this.retrying || !this.retrySynced || this.finishingRetry || this.provider.hasUnsyncedChanges || this.destroyed || this.permissionReset) return;
    this.finishingRetry = true;
    try {
      // A sibling may have persisted more work while the network attempt ran.
      await fetchUpdates(this.persistence);
      if (!this.retrying || this.provider.hasUnsyncedChanges || this.destroyed || this.permissionReset) return;
      const marker = localStorage.getItem(this.blockedKey), latest = storedBlock(marker, this.cacheEpoch);
      if (latest && marker !== this.blockedMarker) { this.blockedMarker = marker; this.pauseSync(latest, false); return; }
      localStorage.removeItem(this.blockedKey); sessionStorage.removeItem(this.blockedKey);
      this.retrying = false; this.blocked = null; this.everLive = true;
      this.callbacks.onSyncBlocked?.(null); this.callbacks.onReadOnly(this.scopeReadOnly); this.callbacks.onStatus('live');
      this.flushPresence();
    } catch { if (this.retrying && this.blocked) this.pauseSync(this.blocked); }
    finally { this.finishingRetry = false; }
  }

  /** Called only after the user explicitly confirms losing this cache's unsynced changes. */
  discardLocalChanges(): void {
    if (this.blocked) this.resetPermissions(true, 'local-changes-discarded');
  }

  /** Coalesce changing awareness only; document gestures are sent immediately. */
  setPresence(patch: Partial<Pick<Presence, 'cursor' | 'selection' | 'editingTextId' | 'viewport'>>): void {
    if (this.destroyed || this.blocked) return;
    this.presence = { ...this.presence, ...patch };
    if (this.presenceTimer !== undefined) return;
    const remaining = 50 - (performance.now() - this.lastPresenceAt);
    if (remaining <= 0) this.flushPresence();
    else this.presenceTimer = setTimeout(() => { this.presenceTimer = undefined; this.flushPresence(); }, remaining);
  }

  private flushPresence(): void {
    if (this.destroyed || this.blocked) return;
    const encoded = JSON.stringify(this.presence);
    if (encoded === this.sentPresence) return;
    this.provider.awareness?.setLocalState(this.presence);
    this.sentPresence = encoded; this.lastPresenceAt = performance.now();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true; clearTimeout(this.presenceTimer); clearTimeout(this.persistenceRetry); cancelAnimationFrame(this.presenceFrame);
    window.removeEventListener('storage', this.storageChanged);
    this.provider.awareness?.setLocalState(null); this.provider.destroy();
    await this.persistence.destroy();
    if (this.discardPersistence) void this.persistence.clearData().catch(() => {});
    // The editor runtime owns board.destroy(), after projection/input subscriptions stop.
  }
}
