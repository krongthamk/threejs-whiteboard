import { createRouter, type Shard } from './router.js';
const shards = JSON.parse(process.env.WHITEBOARD_SHARDS ?? '[{"id":"local","url":"http://127.0.0.1:3001"}]') as Shard[];
const router = createRouter(shards, { port: Number(process.env.ROUTER_PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1', websocketPath: process.env.WHITEBOARD_WEBSOCKET_PATH ?? '/collaboration' });
await router.listen(); console.log(JSON.stringify({ event: 'router-ready', port: router.port, shards: shards.map(shard => shard.id) }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; router.beginDrain(); await new Promise(resolve => setTimeout(resolve, Number(process.env.WHITEBOARD_DRAIN_MS ?? 5000))); await router.close(); }
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
