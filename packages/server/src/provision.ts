import { randomBytes } from 'node:crypto';
import { serverConfig } from './config.js';
import { Store } from './store.js';

const username = process.argv[2];
if (!username) throw new Error('Usage: pnpm --filter @whiteboard/server provision <username> (optional WHITEBOARD_PASSWORD environment variable)');
const supplied = process.env.WHITEBOARD_PASSWORD;
const password = supplied ?? randomBytes(24).toString('base64url');
const options = serverConfig(), store = new Store(options.databasePath, options.sessionSecret);
try {
  const user = store.createUser(username, password);
  console.log(JSON.stringify({ user, ...(supplied ? {} : { temporaryPassword: password }) }));
} finally { store.close(); }
