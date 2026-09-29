import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};
export function staticHandler(directory: string) {
  const root = realpathSync(resolve(directory));
  if (!statSync(root).isDirectory()) throw new Error('Static directory must be a directory');
  const inside = (path: string) => { const segment = relative(root, path); return segment !== '..' && !segment.startsWith(`..${sep}`) && !isAbsolute(segment); };
  return (request: IncomingMessage, response: ServerResponse, pathname: string): boolean => {
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/health' || pathname === '/ready' || !['GET', 'HEAD'].includes(request.method ?? 'GET')) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return false; }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) return false;
    const spa = decoded === '/' || /^\/board\/[a-zA-Z0-9-]+\/?$/.test(decoded);
    const requested = resolve(root, `.${spa ? '/index.html' : decoded}`);
    if (!inside(requested)) return false;
    let file: string, stat: ReturnType<typeof statSync>;
    try { file = realpathSync(requested); if (!inside(file)) return false; stat = statSync(file); if (!stat.isFile()) return false; }
    catch { return false; }
    const extension = extname(file).toLowerCase(), tag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const immutable = /^\/assets\/[^/]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(decoded);
    const cache = extension === '.html' ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    const headers = { 'Cache-Control': cache, ETag: tag, 'X-Content-Type-Options': 'nosniff' };
    if (request.headers['if-none-match'] === tag) { response.writeHead(304, headers); response.end(); return true; }
    response.writeHead(200, { ...headers, 'Content-Type': types[extension] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Last-Modified': stat.mtime.toUTCString() });
    if (request.method === 'HEAD') response.end();
    else { const stream = createReadStream(file); stream.on('error', () => response.destroy()); stream.pipe(response); }
    return true;
  };
}
