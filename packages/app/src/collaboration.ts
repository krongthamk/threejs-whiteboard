import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { BoardDocument, type Point, type Box } from '@whiteboard/model';
import { api, type BoardInfo, type Session } from './api';

export type ConnectionStatus = 'connecting' | 'live' | 'offline' | 'reconnecting' | 'unauthorized';
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
  onPermissionChange(): void;
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
  private presence: Presence;
  private sentPresence = '';
  private lastPresenceAt = -Infinity;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceFrame = 0;
  private everLive = false;
  private destroyed = false;
  private authorizationFailed = false;
  private session: Session;
  private permissionReset = false;
  private discardPersistence = false;
  private readonly cacheEpochKey: string;
  private readonly storageChanged = (event: StorageEvent) => {
    if (event.key === this.cacheEpochKey && event.newValue !== event.oldValue) this.resetPermissions(false);
  };

  private constructor(board: BoardDocument, persistence: IndexeddbPersistence, session: Session, info: BoardInfo, private callbacks: ConnectionCallbacks) {
    this.board = board; this.persistence = persistence; this.session = session;
    this.cacheEpochKey = `whiteboard:${session.user.id}:${info.id}:cache-epoch`;
    window.addEventListener('storage', this.storageChanged);
    this.presence = { userId: session.user.id, name: session.user.name ?? session.user.username, color: session.user.color ?? colorFor(session.user.id), cursor: null, selection: [], editingTextId: null };
    callbacks.onReadOnly(info.role === 'viewer'); callbacks.onStatus('connecting');
    const url = new URL('/collaboration', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('boardId', info.id);
    this.provider = new HocuspocusProvider({
      url: url.href, name: info.id, document: board.doc,
      token: async () => {
        if (this.session.expiresAt > Date.now() + 60_000) return this.session.token;
        try {
          const next = await api.session();
          if (next.user.id !== session.user.id) throw new Error('The signed-in account changed. Reopen the board.');
          this.session = next; return next.token;
        } catch { callbacks.onError('Your session could not be renewed. Sign in again to reconnect.'); return ''; }
      },
      onAuthenticated: ({ scope }) => {
        if (this.destroyed || this.permissionReset) return;
        this.authorizationFailed = false;
        callbacks.onReadOnly(scope === 'readonly');
      },
      onAuthenticationFailed: () => {
        this.authorizationFailed = true; callbacks.onReadOnly(true); callbacks.onStatus('unauthorized');
        callbacks.onError('Access to this board could not be confirmed. Sign in again or contact its owner.');
      },
      onStateless: ({ payload }) => {
        let message: unknown; try { message = JSON.parse(payload); } catch { return; }
        if (message && typeof message === 'object' && 'type' in message && message.type === 'permission-changed'
          && 'boardId' in message && message.boardId === info.id && 'resetRequired' in message && message.resetRequired === true) this.resetPermissions(true);
      },
      onStatus: ({ status }) => {
        if (this.destroyed || this.authorizationFailed) return;
        if (status === 'disconnected') callbacks.onStatus('offline');
        else callbacks.onStatus(this.everLive ? 'reconnecting' : 'connecting');
      },
      onSynced: ({ state }) => {
        if (!state || this.destroyed || this.authorizationFailed) return;
        this.everLive = true; callbacks.onStatus('live');
      },
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
    this.flushPresence();
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
      return new BoardConnection(new BoardDocument(doc, { initializeMetadata: false }), persistence, session, info, callbacks);
    } catch (error) { void persistence.destroy(); doc.destroy(); throw error; }
    finally { clearTimeout(timeout); }
  }

  private resetPermissions(rotateCache: boolean): void {
    if (this.destroyed || this.permissionReset) return;
    this.permissionReset = true; this.authorizationFailed = true; this.discardPersistence = true;
    this.callbacks.onReadOnly(true);
    this.provider.disconnect();
    if (rotateCache) localStorage.setItem(this.cacheEpochKey, crypto.randomUUID());
    // Reopening uses a new cache namespace even if another tab delays old DB deletion.
    this.callbacks.onPermissionChange();
  }

  /** Coalesce changing awareness only; document gestures are sent immediately. */
  setPresence(patch: Partial<Pick<Presence, 'cursor' | 'selection' | 'editingTextId' | 'viewport'>>): void {
    if (this.destroyed) return;
    this.presence = { ...this.presence, ...patch };
    if (this.presenceTimer !== undefined) return;
    const remaining = 50 - (performance.now() - this.lastPresenceAt);
    if (remaining <= 0) this.flushPresence();
    else this.presenceTimer = setTimeout(() => { this.presenceTimer = undefined; this.flushPresence(); }, remaining);
  }

  private flushPresence(): void {
    if (this.destroyed) return;
    const encoded = JSON.stringify(this.presence);
    if (encoded === this.sentPresence) return;
    this.provider.awareness?.setLocalState(this.presence);
    this.sentPresence = encoded; this.lastPresenceAt = performance.now();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true; clearTimeout(this.presenceTimer); cancelAnimationFrame(this.presenceFrame);
    window.removeEventListener('storage', this.storageChanged);
    this.provider.awareness?.setLocalState(null); this.provider.destroy();
    await this.persistence.destroy();
    if (this.discardPersistence) void this.persistence.clearData().catch(() => {});
    // The editor runtime owns board.destroy(), after projection/input subscriptions stop.
  }
}
