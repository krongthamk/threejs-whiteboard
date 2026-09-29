import { createWhiteboardServer } from './server.js';
import { serverConfig } from './config.js';

const options = serverConfig();
const app = createWhiteboardServer(options);
await app.listen();
console.log(JSON.stringify({ event: 'ready', host: options.host, port: app.port, websocketPath: app.websocketPath }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  app.beginDrain();
  await new Promise(resolve => setTimeout(resolve, Number(process.env.WHITEBOARD_DRAIN_MS ?? 5000)));
  await app.close();
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
