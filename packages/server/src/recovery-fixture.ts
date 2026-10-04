// Child-process fixture for the abrupt-exit persistence integration test.
import { join } from 'node:path';
import { createWhiteboardServer } from './server.js';
const data = process.env.RECOVERY_DATA_DIRECTORY;
if (!data) throw new Error('Recovery fixture requires an isolated data directory');
const app = createWhiteboardServer({ databasePath: join(data, 'whiteboard.sqlite'), assetDirectory: join(data, 'assets'), sessionSecret: 'isolated-recovery-test-secret-with-thirty-two-characters', port: 0 });
const user = app.store.userByName('recovery') ?? app.store.createUser('recovery', 'isolated-recovery-password');
const board = app.store.boards(user.id)[0] ?? app.store.createBoard(user.id, 'Recovery test');
const session = (await app.store.login(user.username, 'isolated-recovery-password'))!;
process.on('message', async (message: { type: string }) => {
  if (message.type === 'persisted') process.send?.({ type: 'persisted', ...app.store.stats(board.id) });
  if (message.type === 'stop') { await app.close(); process.disconnect?.(); }
});
await app.listen(); process.send?.({ type: 'ready', port: app.port, boardId: board.id, token: session.token });
