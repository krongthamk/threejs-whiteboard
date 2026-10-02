import { Server, type Connection, type onStoreDocumentPayload } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, BoardFullError, type Session } from './store.js';
import { staticHandler } from './static.js';
import { BoardUpdateValidator, IncompleteBoardUpdateError } from '../../model/src/document-validation.js';
import { checkUpdateResources, UpdateResourceError } from './update-limits.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
interface Options { databasePath: string; assetDirectory: string; sessionSecret: string; port?: number; host?: string; allowedOrigins?: string[]; websocketPath?: string; secureCookies?: boolean; staticDirectory?: string; maxUpdateBytes?: number; maxBoardBytes?: number; maxBufferedBytes?: number; slowSocketGraceMs?: number; maxInboundBytes?: number; maxClockGrowth?: number }
interface AuthContext { token: string; userId: string; role: 'owner' | 'editor' | 'viewer'; expiresAt: number; invalidated?: boolean }
type Metrics = { updates: number; awareness: number; persistedUpdates: number; persistenceMs: number; compactions: number; windowAt: number; windowUpdates: number; windowAwareness: number };

export function createWhiteboardServer(options: Options) {
  const limits = { maxUpdateBytes: options.maxUpdateBytes ?? 4 * 1024 * 1024, maxBoardBytes: options.maxBoardBytes ?? 64 * 1024 * 1024,
    maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024, slowSocketGraceMs: options.slowSocketGraceMs ?? 3000,
    maxInboundBytes: options.maxInboundBytes ?? 8 * 1024 * 1024, maxClockGrowth: options.maxClockGrowth ?? 1_000_000 };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  const serveStatic = options.staticDirectory ? staticHandler(options.staticDirectory) : undefined;
  const store = new Store(options.databasePath, options.sessionSecret, limits.maxBoardBytes);
  mkdirSync(options.assetDirectory, { recursive: true });
  const websocketPath = options.websocketPath ?? '/collaboration';
  const origins = new Set(options.allowedOrigins ?? [4173, 5173, 5174, 3001].flatMap(port => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]));
  const metrics = new Map<string, Metrics>();
  const persistenceFailed = new Map<string, unknown>();
  const updateLocks = new Map<string, Promise<void>>();
  const releaseLocks = new Map<Connection<AuthContext>, () => void>();
  const inbound = new Map<Connection<AuthContext>, { bytes: number; messages: number }>();
  const validators = new Map<Y.Doc, BoardUpdateValidator>();
  const validatorCleanup = new WeakSet<Y.Doc>();
  function validator(document: Y.Doc) {
    let value = validators.get(document);
    if (!value) {
      value = new BoardUpdateValidator(document); validators.set(document, value);
      if (!validatorCleanup.has(document)) {
        validatorCleanup.add(document);
        document.once('destroy', () => { validators.get(document)?.dispose(); validators.delete(document); });
      }
    }
    return value;
  }
  const network = { changes: 0, awarenessMessages: 0, inboundMessages: 0, inboundBytes: 0 };
  const loginAttempts = new Map<string, { since: number; count: number }>();
  const failedLogins = new Map<string, { since: number; count: number }>();
  let draining = false, closed: Promise<void> | undefined;
  function metric(boardId: string): Metrics {
    let value = metrics.get(boardId);
    if (!value) { value = { updates: 0, awareness: 0, persistedUpdates: 0, persistenceMs: 0, compactions: 0, windowAt: Date.now(), windowUpdates: 0, windowAwareness: 0 }; metrics.set(boardId, value); }
    if (Date.now() - value.windowAt > 60000) { value.windowAt = Date.now(); value.windowUpdates = 0; value.windowAwareness = 0; }
    return value;
  }
  const cookieToken = (cookie = '') => { try { return decodeURIComponent(cookie.split(';').map(part => part.trim()).find(part => part.startsWith('board_session='))?.slice(14) ?? ''); } catch { return ''; } };
  function authenticate(request: IncomingMessage): Session {
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : cookieToken(request.headers.cookie);
    const session = store.authenticate(token); if (!session) throw new HttpError(401, 'Sign in to continue'); return session;
  }
  function boardAccess(boardId: string, userId: string, write = false) {
    const board = store.board(boardId, userId); if (!board) throw new HttpError(404, 'Board not found');
    if (write && board.role === 'viewer') throw new HttpError(403, 'This board is read-only'); return board;
  }
  const publicSession = ({ user, token, expiresAt }: Session) => ({ user, token, expiresAt });
  const cookie = (token: string, maxAge = 43200) => `board_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${options.secureCookies ? '; Secure' : ''}`;
  function json(response: ServerResponse, status: number, data?: unknown) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(data === undefined ? undefined : JSON.stringify(data)); }
  async function body(request: IncomingMessage, limit = 65536): Promise<Buffer> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > limit) throw new HttpError(413, 'Upload is too large'); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  }
  async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> { try { const data = JSON.parse((await body(request)).toString()); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON request'); } }
  const title = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new HttpError(400, 'Title must contain 1–200 characters'); return value.trim(); };
  const assetResponse = (boardId: string, assetId: string, mimeType: string) => ({ assetId, mimeType, url: `/api/boards/${boardId}/assets/${assetId}` });
  function resetConnection(connection: Connection<AuthContext>, boardId: string, role: AuthContext['role'] | null, reason = 'permissions-changed') {
    // Permission failures discard the rejected replica; storage failures retain it.
    if (connection.context.invalidated) return;
    connection.context.invalidated = true;
    connection.readOnly = true;
    connection.sendStateless(JSON.stringify({ type: 'permission-changed', boardId, role, resetRequired: true, reason }));
    connection.close({ code: 4403, reason });
  }
  function persistenceFailure(documentName: string, document: onStoreDocumentPayload['document'], error: unknown) {
    persistenceFailed.set(documentName, error);
    console.error({ event: 'persistence-failed', boardId: documentName, error });
    for (const connection of document.getConnections()) {
      try { resetConnection(connection, documentName, connection.context.role, 'persistence-failed'); }
      catch (resetError) { console.error({ event: 'persistence-reset-failed', boardId: documentName, error: resetError }); }
    }
  }
  function persistSnapshot(documentName: string, document: onStoreDocumentPayload['document']) {
    store.compact(documentName, Y.encodeStateAsUpdate(document));
    metric(documentName).compactions++;
    persistenceFailed.delete(documentName);
  }
  function refuseUpdate(connection: Connection<AuthContext>, boardId: string, reason: 'board-full' | 'update-too-large' | 'inbound-overload' | 'incomplete-update', retryable: boolean, maxBytes?: number) {
    if (connection.context.invalidated) return;
    connection.context.invalidated = true; connection.readOnly = true;
    console.warn({ event: 'sync-rejected', boardId, reason, maxBytes });
    connection.sendStateless(JSON.stringify({ type: reason === 'board-full' ? 'board-full' : 'sync-rejected', boardId, reason, retryable, ...(maxBytes === undefined ? {} : { maxBytes }) }));
    connection.close({ code: 4409, reason });
  }
  async function lockUpdate(documentName: string, connection: Connection<AuthContext>) {
    const previous = updateLocks.get(documentName) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; }), tail = previous.then(() => held);
    updateLocks.set(documentName, tail); await previous;
    let released = false;
    releaseLocks.set(connection, () => { if (released) return; released = true; unlock(); releaseLocks.delete(connection); if (updateLocks.get(documentName) === tail) updateLocks.delete(documentName); });
  }
  function messageType(message: Uint8Array): number {
    let position = 0;
    const uint = () => { let value = 0, factor = 1; while (position < message.length) { const byte = message[position++]!; value += (byte & 127) * factor; if (!(byte & 128)) return value; factor *= 128; } return -1; };
    const addressLength = uint(); position += addressLength; return uint();
  }
  async function api(request: IncomingMessage, response: ServerResponse) {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname, method = request.method ?? 'GET';
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new HttpError(403, 'Origin is not allowed');
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Credentials', 'true'); response.setHeader('Vary', 'Origin'); }
      if (method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); return json(response, 204); }
      if (path === '/health') return json(response, 200, { status: 'ok' });
      if (path === '/ready') { const ready = !draining && persistenceFailed.size === 0; return json(response, ready ? 200 : 503, { ready }); }
      if (serveStatic && path !== websocketPath && serveStatic(request, response, path)) return;
      if (serveStatic && !path.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (draining && !['GET', 'HEAD'].includes(method)) throw new HttpError(503, 'Server is draining');
      // Browser cookie mutations must carry an approved Origin. Bearer clients
      // and CLI tools are explicit-token requests and do not use ambient auth.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && request.headers.cookie && !request.headers.authorization && !origin) throw new HttpError(403, 'Origin is required for cookie-authenticated changes');
      if (path === '/api/session' && method === 'POST') {
        const now = Date.now();
        for (const [key, entry] of loginAttempts) if (now - entry.since >= 60000) loginAttempts.delete(key);
        for (const [key, entry] of failedLogins) if (now - entry.since >= 60000) failedLogins.delete(key);
        const address = request.socket.remoteAddress ?? 'local'; let attempts = loginAttempts.get(address);
        if (!attempts) { attempts = { since: now, count: 0 }; loginAttempts.set(address, attempts); }
        if (++attempts.count > 120) throw new HttpError(429, 'Too many sign-in attempts; try again in a minute');
        const data = await jsonBody(request);
        if (typeof data.username !== 'string' || data.username.length > 80 || typeof data.password !== 'string' || data.password.length > 1024) throw new HttpError(400, 'Username and password are required');
        const accountKey = `${address}\0${data.username}`, failures = failedLogins.get(accountKey);
        if (failures && failures.count >= 5) throw new HttpError(429, 'Too many sign-in attempts for this account; try again in a minute');
        const session = store.login(data.username, data.password);
        if (!session) { failedLogins.set(accountKey, { since: failures?.since ?? now, count: (failures?.count ?? 0) + 1 }); throw new HttpError(401, 'Username or password is incorrect'); }
        failedLogins.delete(accountKey);
        response.setHeader('Set-Cookie', cookie(session.token)); return json(response, 200, publicSession(session));
      }
      const session = authenticate(request);
      if (path === '/api/session' && method === 'GET') return json(response, 200, publicSession(session));
      if (path === '/api/session/logout' && method === 'POST') {
        store.logout(session.sessionId);
        // Passive sockets may not send another packet after logout. Revoke their
        // subscription immediately, including queued packets, for this session.
        for (const document of server.hocuspocus.documents.values()) for (const connection of document.getConnections()) {
          if (connection.context.token === session.token) resetConnection(connection, document.name, null, 'session-revoked');
        }
        response.setHeader('Set-Cookie', cookie('', 0)); return json(response, 204);
      }
      if (path === '/api/boards' && method === 'GET') return json(response, 200, { boards: store.boards(session.user.id) });
      if (path === '/api/boards' && method === 'POST') return json(response, 201, { board: store.createBoard(session.user.id, title((await jsonBody(request)).title)) });
      if (path === '/api/metrics' && method === 'GET') return json(response, 200, { boards: store.boards(session.user.id).map(board => {
        const stats = metric(board.id), seconds = Math.max(1, (Date.now() - stats.windowAt) / 1000);
        return { boardId: board.id, connections: server.hocuspocus.documents.get(board.id)?.getConnectionsCount() ?? 0, ...stats, updateRate: stats.windowUpdates / seconds, awarenessRate: stats.windowAwareness / seconds, storage: store.stats(board.id) };
      }) });
      const route = path.match(/^\/api\/boards\/([a-zA-Z0-9-]+)(?:\/(.*))?$/); if (!route) throw new HttpError(404, 'Not found');
      const boardId = route[1]!, suffix = route[2] ?? '', board = boardAccess(boardId, session.user.id, method !== 'GET');
      if (!suffix && method === 'GET') return json(response, 200, { board });
      if (!suffix && method === 'PATCH') { store.rename(boardId, title((await jsonBody(request)).title)); return json(response, 200, { board: store.board(boardId, session.user.id) }); }
      if (suffix === 'members' && method === 'POST') {
        if (board.role !== 'owner') throw new HttpError(403, 'Only the owner can change board membership');
        const data = await jsonBody(request);
        if (typeof data.username !== 'string' || !['editor', 'viewer'].includes(String(data.role))) throw new HttpError(400, 'Specify a username and editor or viewer role');
        const user = store.userByName(data.username); if (!user) throw new HttpError(404, 'User not found');
        if (store.role(boardId, user.id) === 'owner') throw new HttpError(400, 'Owner membership cannot be downgraded');
        const previousRole = store.role(boardId, user.id), role = data.role as 'editor' | 'viewer';
        store.setMember(boardId, user.id, role);
        if (previousRole !== role) for (const connection of server.hocuspocus.documents.get(boardId)?.getConnections() ?? []) {
          if (connection.context.userId === user.id) resetConnection(connection, boardId, role);
        }
        return json(response, 204);
      }
      if (suffix === 'assets' && method === 'POST') {
        const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
        const bytes = await body(request, 20 * 1024 * 1024);
        const png = mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const webp = mimeType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
        if (!png && !jpeg && !webp) throw new HttpError(415, 'Upload a PNG, JPEG, or WebP image');
        const assetId = randomUUID(), storageKey = randomUUID();
        writeFileSync(join(options.assetDirectory, storageKey), bytes, { flag: 'wx', mode: 0o600 });
        store.addAsset({ id: assetId, boardId, mimeType, size: bytes.byteLength, storageKey }); return json(response, 201, assetResponse(boardId, assetId, mimeType));
      }
      if (suffix === 'assets/copy' && method === 'POST') {
        const data = await jsonBody(request);
        if (typeof data.sourceBoardId !== 'string' || typeof data.assetId !== 'string') throw new HttpError(400, 'Source board and asset are required');
        boardAccess(data.sourceBoardId, session.user.id);
        const asset = store.asset(data.sourceBoardId, data.assetId); if (!asset) throw new HttpError(404, 'Asset not found');
        const id = randomUUID(); store.addAsset({ ...asset, id, boardId }); return json(response, 201, assetResponse(boardId, id, asset.mimeType));
      }
      const assetMatch = suffix.match(/^assets\/([a-zA-Z0-9-]+)$/);
      if (assetMatch && method === 'GET') {
        const asset = store.asset(boardId, assetMatch[1]!); if (!asset) throw new HttpError(404, 'Asset not found');
        response.writeHead(200, { 'Content-Type': asset.mimeType, 'Content-Length': asset.size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); return response.end(readFileSync(join(options.assetDirectory, asset.storageKey)));
      }
      throw new HttpError(404, 'Not found');
    } catch (error) { if (!response.headersSent) json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Internal server error' }); else response.end(); }
  }
  class PersistentDatabase extends Database {
    override async onStoreDocument(data: onStoreDocumentPayload) {
      try {
        if (persistenceFailed.has(data.documentName) || store.needsCompaction(data.documentName)) persistSnapshot(data.documentName, data.document);
      } catch (error) { persistenceFailure(data.documentName, data.document, error); }
    }
  }
  const server = new Server<AuthContext>({ port: options.port ?? 3001, address: options.host ?? '127.0.0.1', quiet: true, stopOnSignals: false,
    websocketOptions: { maxPayload: limits.maxUpdateBytes },
    extensions: [new PersistentDatabase({ fetch: async ({ documentName }) => store.loadDocument(documentName) })],
    async onAuthenticate({ token, documentName, requestHeaders, requestParameters, connectionConfig }) {
      if (draining) throw new Error('Server is draining');
      const routedBoard = requestParameters.get('boardId');
      if (routedBoard && routedBoard !== documentName) throw new Error('Document does not match the routed board');
      const origin = requestHeaders.get('origin'); if (origin && !origins.has(origin)) throw new Error('Origin is not allowed');
      const sessionToken = token || cookieToken(requestHeaders.get('cookie') ?? '');
      const session = store.authenticate(sessionToken); if (!session) throw new Error('Authentication required');
      const role = store.role(documentName, session.user.id); if (!role) throw new Error('Board access denied');
      // Replaying an update already applied in memory emits no onChange event.
      // Save the entire retained Doc before permitting reconnect synchronization.
      if (persistenceFailed.has(documentName)) {
        const document = server.hocuspocus.documents.get(documentName);
        if (!document) throw Object.assign(new Error('Board persistence is unavailable'), { reason: 'persistence-failed' });
        try { persistSnapshot(documentName, document); }
        catch (error) { persistenceFailure(documentName, document, error); throw Object.assign(new Error('Board persistence is unavailable'), { reason: 'persistence-failed' }); }
      }
      connectionConfig.readOnly = role === 'viewer'; return { userId: session.user.id, token: sessionToken, role, expiresAt: session.expiresAt };
    },
    async connected({ connection, context, documentName }) {
      let expiration: ReturnType<typeof setTimeout> | undefined;
      let slowTimer: ReturnType<typeof setTimeout> | undefined, droppedDocumentUpdate = false;
      const socket = connection.webSocket as typeof connection.webSocket & { bufferedAmount?: number; terminate?: () => void };
      const send = connection.send.bind(connection);
      connection.send = message => {
        if (!connection.document.hasConnection(connection)) { send(message); return; }
        if ((socket.bufferedAmount ?? 0) > limits.maxBufferedBytes) {
          if (!slowTimer) {
            slowTimer = setTimeout(() => {
              slowTimer = undefined;
              if (droppedDocumentUpdate || (socket.bufferedAmount ?? 0) > limits.maxBufferedBytes) {
                console.warn({ event: 'slow-socket', boardId: documentName });
                socket.terminate?.(); connection.close({ code: 4409, reason: 'slow-consumer' });
              }
            }, limits.slowSocketGraceMs); slowTimer.unref();
          }
          const type = messageType(message);
          if (type === 1) return; // Awareness is ephemeral; stale states never queue.
          if (type === 0 || type === 4) { droppedDocumentUpdate = true; return; } // Reconnect restores the skipped document diff.
        }
        send(message);
      };
      const handle = connection.handleMessage.bind(connection), queue = { bytes: 0, messages: 0 }; inbound.set(connection, queue);
      connection.handleMessage = data => {
        if (context.invalidated) return;
        if (data.byteLength > limits.maxUpdateBytes) { refuseUpdate(connection, documentName, 'update-too-large', false, limits.maxUpdateBytes); return; }
        if (queue.bytes + data.byteLength > limits.maxInboundBytes || queue.messages >= 256) { refuseUpdate(connection, documentName, 'inbound-overload', true, limits.maxInboundBytes); return; }
        queue.bytes += data.byteLength; queue.messages++; handle(data);
      };
      const schedule = () => {
        const remaining = context.expiresAt - Date.now();
        if (remaining <= 0) { resetConnection(connection, documentName, null, 'session-expired'); return; }
        // Recheck the signed deadline if the system wall clock moves backward.
        expiration = setTimeout(schedule, Math.min(remaining, 2_147_483_647)); expiration.unref();
      };
      connection.onClose(() => { clearTimeout(expiration); clearTimeout(slowTimer); releaseLocks.get(connection)?.(); inbound.delete(connection); }); schedule();
    },
    async beforeHandleMessage({ context, documentName, connection, update }) {
      network.inboundMessages++; network.inboundBytes += update.byteLength;
      const session = store.authenticate(context?.token ?? '');
      const role = session ? store.role(documentName, session.user.id) : undefined;
      if (context.invalidated) throw new Error('Connection requires an authoritative reset');
      if (!role || role !== context.role) { resetConnection(connection, documentName, role ?? null); throw new Error('Session or membership changed'); }
      if (update.byteLength > limits.maxUpdateBytes) { refuseUpdate(connection, documentName, 'update-too-large', false, limits.maxUpdateBytes); throw new Error('Update exceeds the size limit'); }
    },
    async beforeSync({ connection, context, document, documentName, type, payload }) {
      if (context.invalidated) throw new Error('Connection requires an authoritative reset');
      // Hocuspocus's negative SyncStatus is ignored by its provider. Explicitly
      // invalidate dirty readonly replicas, including offline edits in SyncStep2.
      if (connection.readOnly && (type === 1 || type === 2) && !Y.snapshotContainsUpdate(Y.snapshot(document), payload)) {
        resetConnection(connection, documentName, 'viewer', 'read-only-write-rejected');
        throw new Error('Read-only changes require an authoritative reset');
      }
      if (!connection.readOnly && (type === 1 || type === 2)) {
        await lockUpdate(documentName, connection);
        try {
          if (context.invalidated) throw new Error('Connection is no longer active');
          if (payload.byteLength > limits.maxUpdateBytes) throw new UpdateResourceError('update-too-large', 'Update exceeds the size limit');
          checkUpdateResources(payload, document, limits.maxClockGrowth);
          const accepted = validator(document).validate(payload);
          if (accepted.byteLength !== 2 || accepted[0] !== 0 || accepted[1] !== 0) store.assertUpdateFits(documentName, accepted.byteLength);
        } catch (error) {
          releaseLocks.get(connection)?.();
          if (error instanceof BoardFullError) {
            validators.get(document)?.dispose(); validators.delete(document);
            refuseUpdate(connection, documentName, 'board-full', true, limits.maxBoardBytes);
          }
          else if (error instanceof IncompleteBoardUpdateError) refuseUpdate(connection, documentName, 'incomplete-update', true);
          else if (error instanceof UpdateResourceError && error.reason === 'update-too-large') refuseUpdate(connection, documentName, 'update-too-large', false, limits.maxUpdateBytes);
          else { console.error({ event: 'invalid-document-update', boardId: documentName, error }); resetConnection(connection, documentName, context.role, 'invalid-document-update'); }
          throw new Error('Invalid document changes require an authoritative reset');
        }
      }
    },
    async afterHandleMessage({ connection, update }) {
      const queue = inbound.get(connection); if (queue) { queue.bytes = Math.max(0, queue.bytes - update.byteLength); queue.messages = Math.max(0, queue.messages - 1); }
      releaseLocks.get(connection)?.();
    },
    async onChange({ documentName, update, document }) {
      try {
        validators.get(document)?.syncLive(update);
        network.changes++;
        const start = performance.now(), stats = metric(documentName); stats.updates++; stats.windowUpdates++;
        store.appendUpdate(documentName, update); stats.persistedUpdates++;
        if (persistenceFailed.has(documentName) || store.needsCompaction(documentName)) persistSnapshot(documentName, document);
        stats.persistenceMs += performance.now() - start;
      } catch (error) { persistenceFailure(documentName, document, error); }
    },
    async beforeUnloadDocument({ documentName }) { if (persistenceFailed.has(documentName)) throw null; },
    async beforeHandleAwareness({ documentName }) { network.awarenessMessages++; const stats = metric(documentName); stats.awareness++; stats.windowAwareness++; },
    async onRequest({ request, response }) { await api(request, response); throw null; },
    async onUpgrade({ request, socket }) { if (new URL(request.url ?? '/', 'http://localhost').pathname !== websocketPath) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); throw null; } },
  });
  return { server, store, metrics, network, websocketPath,
    get port() { const address = server.httpServer.address(); return address && typeof address === 'object' ? address.port : options.port ?? 3001; },
    async listen() { await server.listen(); },
    async close() { if (!closed) closed = (async () => { draining = true; await server.destroy(); for (const value of validators.values()) value.dispose(); validators.clear(); store.close(); })(); return closed; },
    beginDrain() { draining = true; },
  };
}
