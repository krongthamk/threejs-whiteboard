import { randomBytes } from 'node:crypto';
import { serverConfig } from './config.js';
import { Store } from './store.js';

const [argument, selected] = process.argv.slice(2);
const action = argument === '--google' || argument === '--reset-password' || argument === '--revoke-sessions' ? argument : 'create';
const username = action === 'create' ? argument : selected;
if (!username || (action === 'create' && username.startsWith('--'))) throw new Error('Usage: provision <username> | --google <email> | --reset-password <username> | --revoke-sessions <username> (optional WHITEBOARD_PASSWORD environment variable)');
const options = serverConfig(), store = new Store(options.databasePath, options.sessionSecret);
try {
  if (action === '--google') {
    const { id, username: exactUsername, name, avatarUrl } = store.createExternalUser(username);
    console.log(JSON.stringify({ user: { id, username: exactUsername, name, avatarUrl } }));
  } else if (action === '--revoke-sessions') {
    const user = store.userByName(username); if (!user) throw new Error('User not found');
    store.revokeSessions(user.id); console.log(JSON.stringify({ user, sessionsRevoked: true }));
  } else {
    const supplied = process.env.WHITEBOARD_PASSWORD, password = supplied ?? randomBytes(24).toString('base64url');
    const user = action === '--reset-password' ? store.setPassword(username, password) : store.createUser(username, password);
    console.log(JSON.stringify({ user, ...(supplied ? {} : { temporaryPassword: password }) }));
  }
} finally { store.close(); }
