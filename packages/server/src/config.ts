import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function serverConfig() {
  const dataDirectory = resolve(process.env.WHITEBOARD_DATA_DIR ?? 'data');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const secretPath = join(dataDirectory, 'session-secret');
  let sessionSecret = process.env.WHITEBOARD_SESSION_SECRET;
  if (!sessionSecret) {
    try { sessionSecret = readFileSync(secretPath, 'utf8').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const generated = randomBytes(48).toString('base64url');
      try { writeFileSync(secretPath, generated, { flag: 'wx', mode: 0o600 }); sessionSecret = generated; }
      catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; sessionSecret = readFileSync(secretPath, 'utf8').trim(); }
    }
  }
  if (sessionSecret.length < 32) throw new Error('WHITEBOARD_SESSION_SECRET must contain at least 32 characters');
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be 0–65535');
  return {
    databasePath: join(dataDirectory, 'whiteboard.sqlite'),
    assetDirectory: join(dataDirectory, 'assets'), sessionSecret,
    port, host: process.env.HOST ?? '127.0.0.1',
    websocketPath: process.env.WHITEBOARD_WEBSOCKET_PATH ?? '/collaboration',
    secureCookies: process.env.WHITEBOARD_SECURE_COOKIES === '1',
    ...(process.env.WHITEBOARD_STATIC_DIR ? { staticDirectory: resolve(process.env.WHITEBOARD_STATIC_DIR) } : {}),
    ...(process.env.WHITEBOARD_ORIGINS ? { allowedOrigins: process.env.WHITEBOARD_ORIGINS.split(',').map(value => value.trim()).filter(Boolean) } : {}),
  };
}
