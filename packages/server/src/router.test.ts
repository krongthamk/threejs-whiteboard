import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createRouter } from './router';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean, timeout = 1000) {
  const start = performance.now();
  while (!check()) { if (performance.now() - start > timeout) throw new Error('Router lifecycle condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(mode: 'stall' | 'upgrade' | 'reject', upgradeTimeoutMs = 1000) {
  const sockets = new Set<Socket>(), upgrades: Socket[] = [];
  let closedUpgrades = 0, forwarded = '';
  const shard = createServer((_request, response) => { response.writeHead(200); response.end('ready'); });
  shard.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  shard.on('upgrade', (_request, socket) => {
    const remote = socket as Socket;
    upgrades.push(remote); remote.on('close', () => closedUpgrades++);
    // A raw upgraded Node socket is half-open. Consume EOF and release the
    // mock owner's side so close observes cancellation of the router request.
    remote.on('end', () => remote.destroy()); remote.resume();
    if (mode === 'reject') remote.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (mode === 'upgrade') {
      remote.on('data', bytes => { forwarded += bytes.toString(); remote.write(`echo:${bytes}`); });
      remote.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nshard-head');
    }
  });
  await new Promise<void>(resolve => shard.listen(0, '127.0.0.1', resolve));
  const address = shard.address(); if (!address || typeof address === 'string') throw new Error('Shard did not bind');
  const options = { port: 0, upgradeTimeoutMs };
  const router = createRouter([{ id: 'test', url: `http://127.0.0.1:${address.port}` }], options);
  cleanups.push(async () => { await router.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => shard.close(error => error ? reject(error) : resolve())); });
  await router.listen();
  return { router, upgrades, get closedUpgrades() { return closedUpgrades; }, get forwarded() { return forwarded; } };
}
async function downstream(port: number, head = '') {
  const socket = createConnection({ host: '127.0.0.1', port });
  let text = '', closed = false;
  socket.on('error', () => {}); socket.on('close', () => { closed = true; }); socket.on('data', bytes => { text += bytes.toString(); });
  cleanups.push(() => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`GET /collaboration?boardId=test-board HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n${head}`);
  return { socket, get text() { return text; }, get closed() { return closed; } };
}

test('a downstream disconnect cancels its pending upstream upgrade', async () => {
  const upstream = await fixture('stall'), client = await downstream(upstream.router.port);
  await until(() => upstream.upgrades.length === 1); client.socket.destroy();
  await until(() => upstream.closedUpgrades === 1);
});

test('a stalled upstream upgrade has a bounded deadline and closes both sockets', async () => {
  const upstream = await fixture('stall', 40), client = await downstream(upstream.router.port);
  await until(() => upstream.upgrades.length === 1);
  await until(() => client.closed && upstream.closedUpgrades === 1);
});

test('a downstream error before upgrade is handled and cancels the upstream', async () => {
  const upstream = await fixture('stall'); let serverSocket: Socket | undefined;
  upstream.router.server.once('connection', socket => { serverSocket = socket; });
  await downstream(upstream.router.port); await until(() => upstream.upgrades.length === 1);
  expect(() => serverSocket!.emit('error', new Error('Controlled downstream failure'))).not.toThrow();
  await until(() => upstream.closedUpgrades === 1);
});

test('a successful upgrade forwards both handshake heads and live traffic, then closes its peer', async () => {
  const upstream = await fixture('upgrade'), client = await downstream(upstream.router.port, 'client-head');
  await until(() => client.text.includes('shard-head') && upstream.forwarded.includes('client-head'));
  expect(client.text).toContain('HTTP/1.1 101 Switching Protocols');
  client.socket.write('client-live'); await until(() => client.text.includes('echo:client-live'));
  client.socket.destroy(); await until(() => upstream.closedUpgrades === 1);
});

test('a rejected upstream upgrade preserves its status and closes the downstream', async () => {
  const upstream = await fixture('reject'), client = await downstream(upstream.router.port);
  await until(() => client.closed); expect(client.text).toContain('HTTP/1.1 403');
});

test.each([0, -1, NaN, 2 ** 31])('an invalid upgrade timeout is refused (%s)', upgradeTimeoutMs => {
  const options = { port: 0, upgradeTimeoutMs };
  expect(() => createRouter([{ id: 'test', url: 'http://127.0.0.1:1' }], options)).toThrow('upgradeTimeoutMs');
});
