import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';

export interface Shard { id: string; url: string }
/** Rendezvous hashing: adding/removing a node only moves keys owned by that node. */
export function shardFor(boardId: string, shards: readonly Shard[]): Shard {
  if (!shards.length) throw new Error('At least one shard is required');
  return shards.reduce((winner, shard) => {
    const score = (id: string) => createHash('sha256').update(`${boardId}\0${id}`).digest().readBigUInt64BE();
    return score(shard.id) > score(winner.id) ? shard : winner;
  });
}
export function createRouter(shards: Shard[], options: { port?: number; host?: string; websocketPath?: string; upgradeTimeoutMs?: number } = {}) {
  if (!shards.length || shards.some(shard => typeof shard.id !== 'string' || !shard.id.trim()) || new Set(shards.map(shard => shard.id)).size !== shards.length) throw new Error('Shard IDs must be nonempty and unique');
  for (const shard of shards) if (new URL(shard.url).protocol !== 'http:') throw new Error('Shard URLs must be internal HTTP endpoints');
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(upgradeTimeoutMs) || upgradeTimeoutMs <= 0 || upgradeTimeoutMs > 2_147_483_647) throw new Error('upgradeTimeoutMs must be a positive integer no larger than 2147483647');
  const health = new Map<string, boolean>(shards.map(shard => [shard.id, false]));
  let draining = false;
  const websocketPath = options.websocketPath ?? '/collaboration';
  function upstreamUrl(request: IncomingMessage, shard: Shard): URL {
    const incoming = new URL(request.url ?? '/', 'http://router'), upstream = new URL(shard.url);
    // Absolute-form HTTP request targets must never replace the configured host.
    upstream.pathname = incoming.pathname; upstream.search = incoming.search; return upstream;
  }
  async function refresh() {
    await Promise.all(shards.map(async shard => {
      try { health.set(shard.id, (await fetch(new URL('/ready', shard.url), { signal: AbortSignal.timeout(2000) })).ok); }
      catch { health.set(shard.id, false); }
    }));
  }
  function target(request: IncomingMessage, websocket = false): Shard | null {
    if (draining) return null;
    const url = new URL(request.url ?? '/', 'http://router');
    if (websocket && url.pathname !== websocketPath) return null;
    const boardId = url.searchParams.get('boardId') ?? url.pathname.match(/^\/api\/boards\/([a-zA-Z0-9-]+)/)?.[1];
    // A multiplexed socket without a board routing key cannot be routed safely.
    if (websocket && shards.length > 1 && !boardId) return null;
    const selected = boardId ? shardFor(boardId, shards) : shards[0]!;
    return health.get(selected.id) ? selected : null;
  }
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://router').pathname;
    if (pathname === '/health' || pathname === '/ready') {
      const ready = !draining && [...health.values()].every(Boolean);
      response.writeHead(pathname === '/ready' && !ready ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready, shards: Object.fromEntries(health) })); return;
    }
    const shard = target(request);
    if (!shard) { response.writeHead(503); response.end('Board owner is unavailable'); return; }
    const destination = upstreamUrl(request, shard);
    const upstream = httpRequest(destination, { method: request.method, headers: { ...request.headers, host: destination.host } }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Board owner connection failed'); });
    request.on('aborted', () => upstream.destroy()); request.pipe(upstream);
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    let upstream: ReturnType<typeof httpRequest> | undefined, remote: import('node:net').Socket | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined, cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true; clearTimeout(deadline);
      upstream?.destroy(); remote?.destroy(); socket.destroy();
    };
    // Register before starting a request: clients can disappear while an owner
    // is still deciding whether to upgrade. EOF also closes a half-open tunnel.
    socket.on('close', cancel); socket.on('error', cancel); socket.on('end', cancel);
    const shard = target(request, true);
    if (!shard) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n', cancel); return; }
    if (socket.destroyed || socket.readableEnded || socket.writableEnded) { cancel(); return; }
    const destination = upstreamUrl(request, shard);
    deadline = setTimeout(cancel, upgradeTimeoutMs); deadline.unref();
    upstream = httpRequest(destination, { headers: { ...request.headers, host: destination.host } });
    upstream.on('upgrade', (response, peer, remoteHead) => {
      peer.on('error', cancel);
      if (cancelled || socket.destroyed || socket.readableEnded || socket.writableEnded) { peer.destroy(); cancel(); return; }
      remote = peer; clearTimeout(deadline);
      remote.on('close', cancel);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket); socket.pipe(remote);
    });
    upstream.on('response', response => {
      clearTimeout(deadline);
      if (cancelled || socket.destroyed || socket.writableEnded) { response.destroy(); cancel(); return; }
      response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Upgrade Rejected\r\nConnection: close\r\n\r\n`, cancel);
    });
    upstream.on('error', cancel); upstream.end();
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  return { server, refresh, health,
    get port() { const address = server.address(); return address && typeof address === 'object' ? address.port : options.port ?? 3000; },
    async listen() { await refresh(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3000, options.host ?? '127.0.0.1', resolve); }); timer = setInterval(() => { void refresh(); }, 5000); timer.unref(); },
    beginDrain() { draining = true; },
    async close() { draining = true; if (timer) clearInterval(timer); sockets.forEach(socket => socket.destroy()); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
